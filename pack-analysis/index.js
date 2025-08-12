const fs = require('fs');
const path = require('path');
const StreamZip = require('node-stream-zip');
const toml = require('toml');
const moment = require('moment');
const prompt = require('prompt-sync')();
const pc = require('picocolors');
const { spawn, execSync } = require('child_process');

let logIndentLevel = 0;

const addPref = (...args) => {
    if (logIndentLevel <= 0) {
        return args;
    }

    const pref = '| '.repeat(logIndentLevel)

    if (args.length === 0) {
        return pref;
    }
    const firstArg = `${pref}${args[0]}`;

    return [firstArg, ...args.slice(1)];
}

const c = {
    log: (...args) => console.log(pc.white(...addPref(...args))),
    warn: (...args) => console.log(pc.yellow(...addPref(...args))),
    error: (...args) => console.log(pc.red(...addPref(...args))),
    clear: () => console.clear(),
    addLevel: () => logIndentLevel++,
    remLevel: () => logIndentLevel > 0 ? logIndentLevel-- : 0,
    progress: (text, total) => {
        let lastLineLength = 0;
        let lastTotal = total;
        let lastProgress = 0;
        const getCurrPadded = (c, t) => String(c).padStart(String(t ?? lastTotal ?? 0).length, ' ');
        const write = (text) => {
            const textToWrite = text.padEnd(lastLineLength, ' ');
            lastLineLength = text.length;
            if (!debug) {
                process.stdout.cursorTo(0);
                process.stdout.write(...addPref(textToWrite));
            } else {
                c.log(...addPref(textToWrite));
            }
        }
        write(`${text}... ${getCurrPadded(0)}/${total}`);

        return {
            update: (current, total) => {
                lastTotal = total;
                lastProgress = current;
                write(`${text}... ${getCurrPadded(current, total)}/${total}`);
            },
            finish: (customMessage) => {
                write(`${text}... ${lastProgress}/${lastTotal} - ${customMessage ?? 'Done'}`);
                if (!debug) {
                    process.stdout.write('\n');
                }
            }
        }
    }
}

const rootFolder = path.join(__dirname, '..')
const minecraftFolder = path.join(rootFolder, 'minecraft');
const modsFolder = path.join(minecraftFolder, 'mods');
const modIndexFolder = path.join(modsFolder, '.index');
const tempJarsFolder = path.join(rootFolder, 'temp-jars');
const serverFolder = path.join(rootFolder, 'server');
const serverBaseFolder = path.join(rootFolder, 'server-base');

const reportPath = path.join(rootFolder, 'mods.md');
const ignoredOptDepsPath = path.join(rootFolder, 'ignoredOptDeps.txt');

let modFiles;
let mods;

const args = process.argv.slice(2);
// if --report is passed, generate report and exit
const reportOnly = args.includes('--report');
const debug = args.includes('--debug');

const ignoredDeps = [
    'java',
    'minecraft',
    'forge',
    'neoforge'
]

const equivalentMods = [
    ['puzzleslib', 'puzzlesapi', 'puzzlesaccessapi'],
    ['create', 'flywheel', 'ponder'],
    ['fabric', 'fabricloader', 'connector', 'connectormod'],
    ['fabric-api', 'fabric_api', 'fabric-api-base', 'fabric-resource-loader-v0', 'fabric-rendering-v1'],
    ['owo', 'owo-lib'],
    ['xaeroworldmap', 'xaerosworldmap'],
    ['thermal_expansion', 'thermal']
]

const ignoredOptDeps = fs.existsSync(ignoredOptDepsPath) ? [...new Set(fs.readFileSync(ignoredOptDepsPath, 'utf8').split('\n').map(l => l.trim()).filter(l => l))] : [];

async function generateReport() {
    // filter files only
    modFiles = fs.readdirSync(modsFolder).filter((file) => fs.statSync(path.join(modsFolder, file)).isFile() && ['.jar', '.jar.disabled'].some(ext => file.endsWith(ext)));

    const modIndexFiles = fs.readdirSync(modIndexFolder).filter((file) => {
        return fs.statSync(path.join(modIndexFolder, file)).isFile();
    });

    const modMetadata = modIndexFiles.map((file) => {
        return toml.parse(fs.readFileSync(path.join(modIndexFolder, file), 'utf8'));
    });

    c.log(`There are ${modFiles.length} mod files.`);

    mods = []

    const tempJars = []
    if (!fs.existsSync(tempJarsFolder)) {
        fs.mkdirSync(tempJarsFolder);
    }

    const processModFile = async (modFile, insideMod = undefined, layers = 0) => {
        const p = '  '.repeat(layers);
        let hasLoggedForMod = false;
        let logName = `"${modFile}"`;
        let usedLogName = '';
        const logWrapper = (msg, method) => {
            if (!hasLoggedForMod) {
                c.log(`${p}${logName}:`);
                hasLoggedForMod = true;
                usedLogName = logName;
            }
            method(`${layers === 0 ? '|' : ' '} ${p}${msg}`);
        }

        const log = (msg) => logWrapper(msg, c.log)
        const warn = (msg) => logWrapper(msg, c.warn)
        const error = (msg) => logWrapper(msg, c.error)

        const fullPath = insideMod ? path.join(tempJarsFolder, modFile) : path.join(modsFolder, modFile);

        const isDisabled = modFile.endsWith('.jar.disabled');

        const cleanPath = isDisabled ? modFile.slice(0, -9) : modFile;

        const metadata = modMetadata.find((meta) => meta.filename === cleanPath);

        if (!metadata && !insideMod) {
            warn(`No metadata found for ${modFile}`);
        }

        if (!modFile.endsWith('.jar') && !modFile.endsWith('.jar.disabled')) {
            warn(`Skipping ${modFile} because is not a .jar file.`);
        }

        const fileMod = {
            name: (metadata ? metadata.name : modFile).trim(),
            link: metadata?.update?.curseforge?.['project-id'] ? `https://www.curseforge.com/projects/${metadata.update.curseforge['project-id']}`
                : metadata?.update?.modrinth?.['mod-id'] ? `https://modrinth.com/mod/${metadata.update.modrinth['mod-id']}`
                    : undefined,
            isDisabled,
            file: modFile,
            metadata,
            parent: insideMod,
        }

        logName = fileMod.name;

        if (!fileMod.link && !insideMod) {
            warn(`No link found for ${fileMod.name}`);
        }

        const zip = new StreamZip({
            file: fullPath,
            storeEntries: true
        });

        const fileMods = [];

        await new Promise((resolve) => {
            zip.on('ready', () => {
                new Promise(async (resolve1) => {
                    const entries = zip.entries();
                    // find META-INF/mods.toml

                    const modToml = entries['META-INF/mods.toml'];
                    const fabricModJson = entries['fabric.mod.json'];
                    let assumedModLoader = false;

                    fileMod.hasModToml = !!modToml;
                    fileMod.hasFabricModJson = !!fabricModJson;

                    fileMod.isForge = fileMod.hasModToml || fileMod.file.includes('forge');
                    fileMod.isFabric = fileMod.hasFabricModJson || fileMod.file.includes('fabric');

                    let inferringMessage = '';

                    if (!fileMod.hasModToml && !fileMod.hasFabricModJson) {
                        inferringMessage = 'No mods.toml or fabric.mod.json.';

                        if (fileMod.file.toLowerCase().includes('forge')) {
                            inferringMessage += ' Assuming Forge from filename.';
                            fileMod.isForge = true;
                            assumedModLoader = true;
                        }

                        if (fileMod.file.toLowerCase().includes('fabric')) {
                            inferringMessage += ' Assuming Fabric from filename.';
                            fileMod.isFabric = true;
                            assumedModLoader = true;
                        }

                        if (!fileMod.isForge && !fileMod.isFabric) {
                            inferringMessage += ' Could not infer modloader from filename.';
                        }
                    }

                    if (fileMod.isForge && !fileMod.isFabric && !fileMod.hasModToml && !assumedModLoader) {
                        warn(`Forge mod does not have mods.toml.${fileMod.hasFabricModJson ? ' But (weirdly) has fabric.mod.json.' : ''}`);
                    }

                    if (fileMod.isFabric && !fileMod.isForge && !fileMod.hasFabricModJson && !assumedModLoader) {
                        warn(`Fabric mod does not have fabric.mod.json.${fileMod.hasModToml ? ' But (weirdly) has mods.toml.' : ''}`);
                    }

                    if (fileMod.hasModToml) {
                        let modsTomlStr = zip.entryDataSync(modToml).toString('utf8');

                        // fix bug for supplementaries mod, toml key contains dots which is not supported
                        const modsTomlLines = modsTomlStr.split('\n');
                        const fixedModsTomlLines = modsTomlLines.map(line => {
                            if (line.includes('mixin.'))
                                return line.replaceAll('.', '_');
                            return line;
                        });
                        modsTomlStr = fixedModsTomlLines.join('\n');

                        try {
                            const modsToml = toml.parse(modsTomlStr);

                            modsToml.mods.forEach((mod) => {
                                const modName = mod.displayName || fileMod.name;

                                let dependencies = [...new Set((modsToml.dependencies?.[mod.modId] || [])
                                    .filter(dep => !ignoredDeps.includes(dep.modId))
                                    .map(dep => {
                                        let modId = dep.modId;

                                        // check if required mod is equivalent to another
                                        const equivalent = equivalentMods.find(em => em.includes(modId))?.[0];
                                        if (equivalent && equivalent !== modId) {
                                            modId = equivalent;
                                        }

                                        return {
                                            modId,
                                            mandatory: dep.mandatory,
                                        };
                                    }))];

                                fileMods.push({
                                    ...fileMod,
                                    name: modName,
                                    modId: mod.modId,
                                    dependencies: dependencies.filter(dep => dep.mandatory),
                                    optionalDependencies: dependencies.filter(dep => !dep.mandatory && !ignoredOptDeps.includes(dep.modId)),
                                });
                            });
                        } catch (e) {
                            error(`Error parsing mods.toml.`);
                        }
                    } else if (fileMod.hasFabricModJson) {
                        const fabricModJsonStr = zip.entryDataSync(fabricModJson).toString('utf8');
                        const fabricModJsonObj = JSON.parse(fabricModJsonStr);

                        const modName = fabricModJsonObj.name || fileMod.name;
                        const modId = fabricModJsonObj.id;

                        let dependencies = [...new Set(Object.keys(fabricModJsonObj.depends || {})
                            .filter(dep => !ignoredDeps.includes(dep))
                            .map(dep => {
                                let modId = dep;

                                // check if required mod is equivalent to another
                                const equivalent = equivalentMods.find(em => em.includes(dep))?.[0];
                                if (equivalent && equivalent !== dep) {
                                    modId = equivalent;
                                }

                                return {
                                    modId,
                                    mandatory: true,
                                };
                            }))];

                        fileMods.push({
                            ...fileMod,
                            name: modName,
                            modId,
                            dependencies: dependencies,
                            optionalDependencies: [],
                        });

                        if (Array.isArray(fabricModJsonObj.jars)) {
                            // log(`There are ${fabricModJsonObj.jars.length} jars inside.`);

                            for (const { file } of fabricModJsonObj.jars) {
                                const fileName = `${modId}___${file.split('/').pop()}`;
                                const tempJar = path.join(tempJarsFolder, fileName);
                                tempJars.push(tempJar);
                                const data = zip.entryDataSync(file);
                                fs.writeFileSync(tempJar, data);
                                await processModFile(fileName, modId, layers + 1);
                            }
                        }
                    } else {
                        const modId = fileMod.file.replace('.jar', '').split('-')[0].toLowerCase();
                        inferringMessage += ` Assuming modId "${modId}" from filename.`;
                        warn(inferringMessage);
                        fileMods.push({
                            ...fileMod,
                            modId: modId,
                        });
                    }

                    zip.close();

                    resolve1();
                    resolve();
                });
            });
        });

        for (const fileMod of fileMods) {
            if (mods.find(m => m.modId === fileMod.modId)) {
                // warn(`Mod ${fileMod.name} (${fileMod.modId}) already exists.`);
                continue;
            }

            mods.push(fileMod);
        }

        if (hasLoggedForMod) {
            c.log('');
        }
    }

    for (const modFile of modFiles) {
        await processModFile(modFile);
    }

    // delete tempjars
    tempJars.forEach(jar => {
        fs.unlinkSync(jar);
    });

    // delete tempjars folder
    fs.rmdirSync(tempJarsFolder);

    // fix dependencies arrays
    mods.forEach((mod) => {
        mod.dependencies = mod.dependencies || [];
        mod.optionalDependencies = mod.optionalDependencies || [];
    });

    const disabledDeps = []
    const goneDeps = []

    // check multiple mods with same name
    const names = mods.map(m => m.name);
    const duplicates = names.filter((name, i) => names.indexOf(name) !== i);

    if (duplicates.length > 0) {
        c.warn(`Found mods with duplicate names:`);
        c.addLevel();

        for (const name of duplicates) {
            const modsWithName = mods.filter(m => m.name === name);
            c.warn(`${name} (${modsWithName.length})`);
            c.addLevel();
            modsWithName.forEach(m => {
                c.warn(m.modId);
                m.name = `${m.name} (${m.modId})`;
            });
            c.remLevel();
        }
        c.remLevel();

        c.log('');
    }

    // checking dependencies
    mods.forEach((mod) => {
        [mod.dependencies, mod.optionalDependencies].forEach((depArray) => {
            depArray.forEach((dep) => {
                const depMod = mods.find(m => {
                    if (m.modId === dep.modId) return true;
                    if (equivalentMods.find(em => em.includes(dep.modId) && em.includes(m.modId))) return true;
                    return false;
                });

                if (depMod) {
                    depMod.dependents = depMod.dependents || [];
                    depMod.dependents.push(mod.modId + (dep.mandatory ? '' : '?'));

                    dep.name = depMod.name;
                    if (!dep.mandatory) {
                        dep.modId += '!';
                    } else if (depMod.isDisabled) {
                        if (!mod.isDisabled) {
                            c.error(`Mod ${mod.name} (${mod.modId}) depends on ${dep.modId} but it is disabled.`);
                            disabledDeps.push(dep.modId);
                        }
                    }
                } else {
                    if (dep.mandatory) {
                        if (!mod.isDisabled) {
                            c.error(`Mod ${mod.name} (${mod.modId}) depends on ${dep.modId} but it is not present.`);
                            goneDeps.push(dep.modId);
                        }
                    }
                }
            });
        });
    });

    if (disabledDeps.length > 0) {
        c.warn(`Found ${disabledDeps.length} disabled dependencies:`);
        c.warn(disabledDeps.map(m => `- ${m}`).join('\n'));

        if (prompt('Do you want to enable them? (y/n) ') === 'y') {
            for (const depId of disabledDeps) {
                const dep = mods.find(m => m.modId === depId);
                if (dep) {
                    await commands.toggleMod(dep.modId, true);
                }
            }
        }
    }

    // fix dependents arrays
    mods.forEach((mod) => {
        mod.dependents = mod.dependents || [];
    });

    // read dynamic data from previous report
    let previousReport = '';

    if (fs.existsSync(reportPath)) {
        previousReport = fs.readFileSync(reportPath, 'utf8');
    }

    let recoveredCount = 0;
    let goneMods = [];

    if (previousReport) {
        const prevReportLines = previousReport.split('\n');
        const prevReportTableLines = prevReportLines.filter(line => line.startsWith('|')).slice(2);

        prevReportTableLines.forEach(line => {
            const split = line.split('|').filter(cell => cell).map(cell => cell.trim());
            const modLoader = split[1].trim();
            const modId = split[2].trim();
            let nameWithLink = split[3].trim();
            let side = split[4].trim();
            const category = split[5].trim();
            const rawDependents = split[6].trim();
            const rawDeps = split[7].trim();
            const rawOptDeps = split[8].trim();

            const nameHasLink = nameWithLink.includes(']')
            const nameHasParent = nameWithLink.includes(' > ');
            const name = nameHasParent ? nameWithLink.split(' > ')[1] : nameHasLink ? nameWithLink.slice(1, nameWithLink.lastIndexOf(']')) : nameHasParent ? nameWithLink.split(' > ')[1] : nameWithLink;
            const link = nameHasLink ? nameWithLink.slice(nameWithLink.lastIndexOf(']') + 2, nameWithLink.length - 1) : undefined;

            if (side === 'unknown' || side.endsWith('?') || !side)
                side = undefined;

            if (category === '') return;
            if (category.endsWith('?')) return;

            const mod = mods.find(m => m.name === name);

            if (mod) {
                mod.category = category;
                mod.side = side;
                recoveredCount++;
            } else {
                goneMods.push(name);
                mods.push({
                    name,
                    link,
                    modId,
                    isGone: true,
                    category: category,
                    rawDependents,
                    rawDeps,
                    rawOptDeps,
                    dependents: [],
                    dependencies: [],
                    optionalDependencies: [],
                    isForge: modLoader.includes('Forge'),
                    isFabric: modLoader.includes('Fabric'),
                    side,
                });
            }
        });
    }
    c.log(`Recovered ${recoveredCount} categories from previous report.`);
    if (goneMods.length > 0) {
        c.log(`Found ${goneMods.length} mods in previous report that aren't on the current mod list. (Marking as gone)`);
    }

    // auto-categorize mods

    let autoCategorized = 0;

    mods.filter(mod => !mod.category).forEach((mod) => {
        const prevCategory = mod.category;

        // mods with dependents but no dependencies: library mods
        if ((mod.dependents.length > 0 && !mod.dependencies.length) || `${mod.modId} ${mod.name}`.includes('api') || `${mod.modId} ${mod.name}`.includes('lib')) {
            mod.category = 'Library?';
        } else if (mod.name.toLowerCase().includes('fix')) {
            mod.category = 'Fix?';
        } else if (mod.parent) {
            mod.category = 'Library?'
        } else {
            if (mod.dependencies.length > 0 && mod.dependents.length === 0) {
                // addon or integration?

                // must have dep (obviously) and no dependents

                // get all dep categories, filter out libraries
                const depCategories = mod.dependencies.map(dep => mods.find(m => m.modId === dep.modId)?.category).filter(c => c !== 'Library');

                if (depCategories.length === 1) {
                    // assume addon
                    mod.category = 'Addon?';
                } else if (depCategories.length === 2) {
                    // assume integration
                    mod.category = 'Integration?';
                }
            } else if (mod.name.toLowerCase().includes('compat')) {
                mod.category = 'Integration?';
            }
        }


        if (prevCategory !== mod.category) {
            autoCategorized++;
        }
    });

    const modsMissingCategory = mods.filter(m => !m.category).length;

    if (autoCategorized > 0 || modsMissingCategory > 0) {
        c.log(`New mods found!`);
        c.log(`- ${autoCategorized} auto-categorized.`);
        c.log(`- ${modsMissingCategory} missing category.`);
    }

    // set side if not set
    mods.filter(mod => !mod.side).forEach((mod) => {
        if (mod.parent)
            mod.side = 'N/A';
        else if (mod.metadata?.side)
            mod.side = mod.metadata.side + '?';
    });

    const modsMissingSide = mods.filter(m => !m.side && !m.isGone).length;

    if (modsMissingSide > 0) {
        c.warn(`There are ${modsMissingSide} mods with no side set.`);
    }

    // sort mods by category then by name
    mods.sort((a, b) => {
        if (a.isGone && !b.isGone) return 1;
        if (!a.isGone && b.isGone) return -1;

        const aAutoOrMissing = !a.category || a.category.endsWith('?');
        const bAutoOrMissing = !b.category || b.category.endsWith('?');
        if (aAutoOrMissing && !bAutoOrMissing) return -1;
        if (!aAutoOrMissing && bAutoOrMissing) return 1;

        if (a.category && b.category) {
            if (a.category === b.category) return a.name.localeCompare(b.name);
            return a.category.localeCompare(b.category);
        }
        if (a.category) return -1;
        if (b.category) return 1;

        const aName = a.parent ? `${a.parent} > ${a.name}` : a.name;
        const bName = b.parent ? `${b.parent} > ${b.name}` : b.name;

        return aName.localeCompare(bName);
    });


    // generate report

    const modsWithNoCategory = mods.filter(m => !m.category).length;

    const reportHeaderLines = [
        "# TiozinNub's Pack 5.2",
        "> Auto-generated at " + moment().format('YYYY-MM-DD HH:mm:ss'),
        `\`${mods.length}\` mods (\`${mods.filter(m => m.isDisabled).length}\` disabled, \`${mods.filter(m => m.isGone).length}\` gone)`,
        modsWithNoCategory > 0 ? `\`${mods.filter(m => !m.category).length}\` mods have no category (\`${autoCategorized}\` were auto-categorized)` : undefined,
    ]

    let reportText = [...reportHeaderLines.filter(l => l !== undefined), ''].join('\n\n');

    const reportCols = [
        { title: '', render: (mod) => mod.isGone ? '❓' : mod.isDisabled ? '❌' : '✅' },
        { title: 'Modloader', render: (mod) => [mod.isForge ? 'Forge' : undefined, mod.isFabric ? 'Fabric' : undefined].filter(ml => ml).join('/') ?? 'N/A' },
        { title: 'Mod ID', render: (mod) => mod.parent ? `${mod.parent} > ${mod.modId}` : mod.modId },
        { title: 'Name', render: (mod) => mod.link ? `[${mod.name.replace(/\|/g, '\\|')}](${mod.link})` : mod.name },
        { title: 'Side', render: (mod) => mod.side || '' },
        { title: 'Category', render: (mod) => mod.category || '' },
        {
            title: 'Dependents', render: (mod) => {
                if (mod.rawDependents) return mod.rawDependents;

                const text = mod.dependents.map(d => `\`${d}\``).join(', ');
                if (text.length <= 30)
                    return text;
                return `${mod.dependents.length} dependents`;
            }
        },
        {
            title: 'Deps (no libs)', render: (mod) => {
                if (mod.rawDeps) return mod.rawDeps;

                const text = mod.dependencies.filter(dep => mods.find(m => m.modId === dep.modId && m.category !== 'Library')).map(d => d.modId).map(d => `\`${d}\``).join(', ');
                if (text.length <= 20)
                    return text;
                return `${mod.dependencies.length} dependencies`;
            }
        },
        {
            title: 'Opt. Deps (unsatisfied)', render: (mod) => {
                if (mod.rawOptDeps) return mod.rawOptDeps;
                if (mod.optionalDependencies.length === 0) return '';
                const optDeps = mod.optionalDependencies
                    .filter(dep => !mods.find(m => m.modId === dep.modId.replace('!', '').replace('?', '')));
                const firstTen = optDeps.slice(0, 10).map(d => d.modId).map(d => `\`${d}\``).join(', ');
                const hasMore = optDeps.length > 10;
                const unsatisfiedText = ` (\`${optDeps.length}\` uns.: ${firstTen}${hasMore ? '...' : ''})`;
                return `\`${mod.optionalDependencies.length}\`${optDeps.length > 0 ? unsatisfiedText : ' satisfied'}`;
            }
        },
        // {
        //     title: 'Dpc/OptDpcS/OptDpcNS',
        //     render: mod => {
        //         const optDpc = mod.optionalDependencies.length;
        //         const optDpcS = mod.optionalDependencies.filter(dep => mods.find(m => m.modId === dep.modId)).length;
        //         return `\`${mod.dependencies.length}\` dpc, \`${optDpcS}\` optDpcS, \`${optDpc - optDpcS}\` optDpcNS`;
        //     }
        // }
    ]

    const reportRows = mods.map((mod) => reportCols.map((col) => col.render(mod) + ''));

    // add colWidths to reportCols
    reportCols.forEach((col, i) => {
        col.width = col.width || Math.max(col.title.length + 2, ...reportRows.map(row => row[i].length + 2));
    });

    // render header
    reportText += `|${reportCols.map((col) => (' ' + col.title).padEnd(col.width)).join('|')}|\n`;
    reportText += `|${reportCols.map((col) => '-'.repeat(col.width)).join('|')}|\n`;

    // render rows
    reportRows.forEach((row) => {
        reportText += `|${row.map((cell, i) => (' ' + cell).padEnd(reportCols[i].width)).join('|')}|\n`;
    });


    // write report
    fs.writeFileSync(reportPath, reportText);
}

const isServerRunning = () => {
    // check if server is currently running
    const serverPidFile = path.join(serverFolder, 'server.pid');
    if (!fs.existsSync(serverPidFile)) {
        return undefined;
    }

    return Number(fs.readFileSync(serverPidFile, 'utf8').trim());
}

const commands = {
    toggleMod: async (modId, enabled) => {
        const mod = mods.find(m => m.modId === modId);

        if (!mod) {
            c.warn(`Mod "${modId}" not found.`);
            return;
        }

        if (mod.isDisabled === !enabled) {
            c.warn(`Mod "${mod.name}" is already ${enabled ? 'enabled' : 'disabled'}.`);
            return;
        }

        if (mod.isGone) {
            c.warn(`Mod "${mod.name}" is gone.`);
            return;
        }

        const toggleMod = async (mod, pref = '') => {
            c.log(`${pref}${enabled ? 'Enabling' : 'Disabling'} mod "${mod.name}"...`);
            const fullPath = path.join(modsFolder, mod.file);
            const cleanPath = mod.file.replace('.disabled', '');
            const newPath = enabled ? cleanPath : cleanPath + '.disabled';
            const newFullPath = path.join(modsFolder, newPath);
            fs.renameSync(fullPath, newFullPath);

            mod.isDisabled = !enabled;
            mod.file = newPath;
        }

        await toggleMod(mod);

        const disableDependents = async (mod, pref = '') => {
            c.log(`${pref}Mod ${mod.name} has ${mod.dependents.length} dependents.`);

            for (const depId of mod.dependents) {
                if (depId.endsWith('?')) {
                    c.warn(`${pref}Optional dependent ${depId} not disabled.`);
                    continue;
                }

                const cleanModId = depId.replace('!', '');
                const dep = mods.find(m => m.modId === cleanModId);
                if (!dep) {
                    c.warn(`${pref}Dependent ${depId} not found.`);
                    continue;
                }

                if (dep.isDisabled) {
                    c.warn(`${pref}Dependent ${dep.name} is already disabled.`);
                    continue;
                }

                await toggleMod(dep, pref);

                if (dep.dependents.length > 0) {
                    await disableDependents(dep, pref + '  ');
                }
            }
        }

        const enableDependencies = async (mod, pref = '') => {
            c.log(`${pref}Mod ${mod.name} has ${mod.dependencies.length} dependencies.`);
            for (const dep of mod.dependencies) {
                const cleanModId = dep.modId.replace('!', '');
                const depMod = mods.find(m => m.modId === cleanModId);

                if (!depMod) {
                    c.warn(`${pref}Dependency ${dep.modId} not found.`);
                    continue;
                }

                if (!depMod.isDisabled) {
                    c.warn(`${pref}Dependency ${depMod.name} is already enabled.`);
                    continue;
                }

                await toggleMod(depMod, pref);

                if (depMod.dependents.length > 0) {
                    await enableDependencies(depMod, pref + '  ');
                }
            }
        }

        if (enabled) {
            if (mod.dependencies.length > 0) {
                await enableDependencies(mod, '  ');
            }
        } else {
            if (mod.dependents.length > 0) {
                await disableDependents(mod, '  ');
            }
        }

        c.log(`Mod "${mod.name}" ${enabled ? 'enabled' : 'disabled'}.`);
    },
    server: async () => {
        if (isServerRunning()) {
            c.warn("Server is running. Can't generate server.");
            return;
        }

        c.log('Generating server...');

        if (fs.existsSync(serverFolder)) {
            fs.rmSync(serverFolder, { recursive: true, force: true });
        }

        fs.cpSync(serverBaseFolder, serverFolder, { recursive: true });

        const onServer = (p) => path.join(serverFolder, p);
        const onClient = (p) => path.join(minecraftFolder, p);

        // copy configs
        fs.cpSync(onClient('config'), onServer('config'), { recursive: true });
        fs.cpSync(onClient('defaultconfigs'), onServer('defaultconfigs'), { recursive: true });

        fs.mkdirSync(onServer('mods'));

        const copiedFiles = [];

        const operations = [];

        // copy mods
        for (const mod of mods) {
            if (copiedFiles.includes(mod.file)) continue;

            if (mod.isGone) continue;
            if (mod.isDisabled) continue;
            if (mod.parent) continue;

            let side = mod.side;
            let uncertain = false;
            if (side.endsWith('?')) {
                side = side.slice(0, -1);
                uncertain = true;
            }

            if (!['server', 'both'].includes(side) && !uncertain) continue;

            const modFile = path.join(modsFolder, mod.file);
            const destFile = path.join(serverFolder, 'mods', mod.file);
            operations.push({ src: modFile, dest: destFile });
            copiedFiles.push(mod.file);
        }

        const progress = c.progress('Copying server mod files');

        for (let id = 0; id < operations.length; id++) {
            const operation = operations[id];
            fs.copyFileSync(operation.src, operation.dest);

            progress.update(id + 1, operations.length);
        }
        progress.finish();
    },
    runServer: async () => {
        let pid = isServerRunning();

        if (pid) {
            c.warn(`Server is already running with PID ${pid}.`);
            return;
        }

        const child = spawn('bash', [
            '-c',
            'screen -d -m -S mc-server ./run.sh'
        ], {
            detached: true,
            stdio: 'ignore',
            cwd: serverFolder
        });

        child.unref();

        while (!(pid = isServerRunning())) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        c.log(`Server started in a screen named "mc-server". (PID: ${pid})`);
    },
    stopServer: async () => {
        let pid = isServerRunning();

        if (!pid) {
            c.warn('Server is not running. (No PID)');
        }

        // list screen, find mc-server

        const listScreensCommand = 'screen -list';
        const screens = execSync(listScreensCommand, { cwd: serverFolder, stdout: 'pipe' }).toString();
        const mcServerScreen = screens.split('\n').find(line => line.includes('mc-server'));

        if (mcServerScreen) {
            const screenId = mcServerScreen.split('.')[0];
            execSync(`screen -S ${screenId} -X stuff stop^M`);

            const maxWait = 15;
            const progress = c.progress('Waiting for server to stop', maxWait);
            let secondsPassed = 0;
            let failedToStop = false;

            do {
                progress.update(secondsPassed, maxWait);

                await new Promise(resolve => setTimeout(resolve, 1000));
                secondsPassed++;

                if (secondsPassed >= maxWait) {
                    failedToStop = true;
                    progress.update(maxWait, maxWait);
                    progress.finish('Failed');
                    break;
                }
            } while (pid = isServerRunning());

            if (!failedToStop) {
                progress.update(secondsPassed, maxWait);
                progress.finish();
                c.log('Server stopped.');
                return;
            }

            c.warn('Failed to stop server gracefully. Killing PID.');
        } else {
            c.warn('Server is not on a screen.');
        }

        if (pid) {
            // get java process PID from bash PID
            c.log(`From Bash PID ${pid}, finding Java PID`);
            const psOutput = execSync(`ps --ppid ${pid} -o pid,cmd`, { stdout: 'pipe' }).toString();
            const javaLine = psOutput.split('\n').find(line => line.includes('java')).trim();
            const javaPid = Number(javaLine ? Number(javaLine.split(' ')[0]) : null);

            c.log(`Found Java PID: ${javaPid}`);

            process.kill(javaPid);

            await new Promise(resolve => setTimeout(resolve, 1000));

            if (pid = isServerRunning()) {
                c.warn('Server is still running after kill signal.');
            } else {
                c.warn('Server stopped forcefully.');
            }
        } else {
            c.warn("No PID? Can't kill server.");
        }
    },
    autofix: async () => {
        c.log('Auto-fixing config files...');

        // attributefix.json: sort all attributes
        const attributeFixPath = path.join(minecraftFolder, 'config', 'attributefix.json');
        if (fs.existsSync(attributeFixPath)) {
            const attributeFix = JSON.parse(fs.readFileSync(attributeFixPath, 'utf8'));

            // sort all attributes
            const attributes = attributeFix.attributes;
            const newAttributes = {};
            Object.keys(attributes).sort().forEach((key) => {
                const attr = attributes[key];
                newAttributes[key] = attr;
            });
            attributeFix.attributes = newAttributes;
            fs.writeFileSync(attributeFixPath, JSON.stringify(attributeFix, null, 2));
            c.log(`Fixed AttributeFix config.`);
        }

        // curios.json: sort and format
        const curiosJsonPath = path.join(minecraftFolder, 'config', 'InventoryHUD', 'curios.json');
        if (fs.existsSync(curiosJsonPath)) {
            const curios = JSON.parse(fs.readFileSync(curiosJsonPath, 'utf8'));

            // sort
            // const keys = Object.keys(curios).sort(); // not sorting temporarily to see the default order
            const newCurios = {};
            keys.forEach((key) => {
                newCurios[key] = curios[key];
            });
            fs.writeFileSync(curiosJsonPath, JSON.stringify(newCurios, null, 2));
            c.log(`Fixed Curios config.`);
        }

        // recipe-category-sort-order.ini: Set correct order of categories
        const jeiRecipeCategorySortOrderPath = path.join(minecraftFolder, 'config', 'jei', 'recipe-category-sort-order.ini');
        if (fs.existsSync(jeiRecipeCategorySortOrderPath)) {
            const jeiRecipeCategorySortOrder = fs.readFileSync(jeiRecipeCategorySortOrderPath, 'utf8');
            const categories = jeiRecipeCategorySortOrder.split('\n').filter(Boolean);

            // starts with minecraft: and (Ice and Fire) doesn't end with dragonforge
            const vanillaCategories = categories.filter(c => c.startsWith('minecraft:') && !c.endsWith('dragonforge'));
            const nonVanillaCategories = categories.filter(c => !vanillaCategories.includes(c));

            // sort vanilla categories, keeping minecraft:crafting the first
            vanillaCategories.sort((a, b) => {
                if (a === 'minecraft:crafting') return -1;
                if (b === 'minecraft:crafting') return 1;
                return a.localeCompare(b);
            });

            // sort non-vanilla categories, keeping jei:information first
            nonVanillaCategories.sort((a, b) => {
                if (a === 'jei:information') return -1;
                if (b === 'jei:information') return 1;
                return a.localeCompare(b);
            });
            const newCategories = [...vanillaCategories, ...nonVanillaCategories];

            fs.writeFileSync(jeiRecipeCategorySortOrderPath, newCategories.join('\n'));
            c.log(`Fixed JEI Recipe Category Sort Order config.`);
        }

        // emi.json: remove any user-specific stuff
        const emiJsonPath = path.join(minecraftFolder, 'emi.json');
        if (fs.existsSync(emiJsonPath)) {
            const emiJson = JSON.parse(fs.readFileSync(emiJsonPath, 'utf8'));

            // remove user-specific stuff
            emiJson.favorites = [];
            emiJson.lookup_history = [];
            emiJson.craft_history = [];
            emiJson.recipe_defaults = {
                added: [],
                tags: {},
                resolutions: {},
                disabled: []
            };

            fs.writeFileSync(emiJsonPath, JSON.stringify(emiJson, null, 2));
            c.log(`Fixed EMI config.`);
        }

        // Copy over any new serverconfig
        if (fs.existsSync(serverFolder)) {
            const serverWorldConfigFolder = path.join(serverFolder, 'world', 'serverconfig');
            if (fs.existsSync(serverWorldConfigFolder)) {
                // delete defaultconfigs folder
                const defaultConfigsFolder = path.join(minecraftFolder, 'defaultconfigs');
                if (fs.existsSync(defaultConfigsFolder)) {
                    fs.rmSync(defaultConfigsFolder, { recursive: true, force: true });
                }

                // copy the serverconfigs
                fs.cpSync(serverWorldConfigFolder, defaultConfigsFolder, { recursive: true });

                c.log('Synced the defaultconfigs.');
            } else {
                c.warn('No world config files found to copy.');
                c.warn('Run the server to generate them.');
            }
        } else {
            c.warn('No server files found to copy.');
            c.warn('Run the "server" command to generate them.');
        }

        // .gitignore: sort
        const gitignorePath = path.join(rootFolder, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            const gitignore = fs.readFileSync(gitignorePath, 'utf8');
            const sorted = gitignore.split('\n').filter(Boolean).sort().join('\n');
            fs.writeFileSync(gitignorePath, sorted);
            c.log(`Fixed .gitignore.`);
        }

        // jade/plugins.json: sort
        const jadePluginsJsonPath = path.join(minecraftFolder, 'config', 'jade', 'plugins.json');
        if (fs.existsSync(jadePluginsJsonPath)) {
            const plugins = JSON.parse(fs.readFileSync(jadePluginsJsonPath, 'utf8'));

            // first is always minecraft
            const newPlugins = {
                minecraft: plugins.minecraft,
            };

            Object.keys(plugins).filter(key => key !== 'minecraft').sort().forEach((key) => {
                newPlugins[key] = plugins[key];
            });

            fs.writeFileSync(jadePluginsJsonPath, JSON.stringify(newPlugins, null, 2));
            c.log(`Fixed Jade Plugins order.`);
        }
    }
}

async function main() {
    c.clear();
    c.log("TiozinNub's Pack 5.2 - Tools");

    await generateReport();
    c.log('Report generated.');

    while (!reportOnly && !debug) {
        const command = prompt('Type command: ');

        // get first word, safely
        if (!command) break;
        const split = command.trim().split(' ');
        if (split.length === 0) continue;
        const commandName = split[0].toLowerCase();

        c.addLevel();
        switch (commandName) {
            case 'report':
                await generateReport();
                c.log('Report generated.');
                break;
            case 'disable':
                if (split.length < 2) {
                    c.warn('Usage: disable <modId>');
                    break;
                }

                await commands.toggleMod(split[1], false)

                break;

            case 'enable':
                if (split.length < 2) {
                    c.warn('Usage: enable <modId>');
                    break;
                }

                await commands.toggleMod(split[1], true)

                break;

            case 'category':
                if (split.length < 3 || !['list', 'enable', 'disable'].includes(split[2])) {
                    c.warn('Usage: category <name> <list|enable|disable>');
                    break;
                }

                const categoryName = split[1];
                const categoryAction = split[2];

                const categories = [...new Set(mods.map(m => m.category))].filter(c => c);

                if (!categories.includes(categoryName)) {
                    c.warn(`Category "${categoryName}" not found.`);
                    break;
                }

                const categoryMods = mods.filter(m => m.category === categoryName);

                if (categoryAction === 'list') {
                    c.log(`Category "${categoryName}" has ${categoryMods.length} mods:`);
                    categoryMods.forEach((mod) => {
                        c.log(`- ${mod.name} (${mod.modId})`);
                    });
                } else {
                    c.log(`${categoryAction === 'enable' ? 'Enabling' : 'Disabling'} category "${categoryName}"...`);
                    for (const mod of categoryMods) {
                        await commands.toggleMod(mod.modId, categoryAction === 'enable');
                    }
                }

                break;
            case 'list':
                if (split.length < 3 || !['dependents', 'dependencies', 'optionaldeps'].includes(split[1])) {
                    c.warn('Usage: list <dependents|dependencies|optionaldeps> <modId>');
                    break;
                }

                const listAction = split[1];
                const mod = mods.find(m => m.modId === split[2]);

                if (!mod) {
                    c.warn(`Mod "${split[2]}" not found.`);
                    break;
                }

                const actionPretty = listAction === 'dependents' ? 'Dependents' : listAction === 'dependencies' ? 'Dependencies' : 'Optional Dependencies';
                let list = [];

                const findMod = (modId) => mods.find(m => m.modId === modId.replace('!', '').replace('?', ''));

                if (listAction === 'dependents') {
                    list = mod.dependents.map(dep => findMod(dep));
                } else if (listAction === 'dependencies') {
                    list = mod.dependencies.map(dep => findMod(dep.modId))
                } else if (listAction === 'optionaldeps') {
                    list = mod.optionalDependencies.map(dep => findMod(dep.modId))
                }

                c.log(`Mod "${mod.name}" has ${list.length} ${actionPretty}:`);

                list.forEach((dep) => {
                    c.log(`- ${dep.name} (${dep.modId})`);
                });

                break;

            case 'ignore':
                if (split.length < 2) {
                    c.warn('Usage: ignore <modId>');
                    break;
                }

                const modId = split[1];

                if (ignoredOptDeps.includes(modId)) {
                    c.warn(`Mod "${modId}" is already ignored.`);
                    break;
                }

                ignoredOptDeps.push(modId);
                ignoredOptDeps.sort();

                fs.writeFileSync(ignoredOptDepsPath, ignoredOptDeps.join('\n'));

                c.log(`Mod "${modId}" ignored.`);

                break;

            case 'optional':
                // list all recommended deps
                const optionalDeps = [...new Set(mods.flatMap(m => m.optionalDependencies.map(dep => dep.modId.replace('!', '').replace('?', ''))))];
                const unsatisfiedOptionalDeps = optionalDeps.filter(dep => !mods.find(m => m.modId === dep));
                unsatisfiedOptionalDeps.sort();

                c.log(`There are ${unsatisfiedOptionalDeps.length} unsatisfied optional dependencies (${ignoredOptDeps.length} ignored):`);
                unsatisfiedOptionalDeps.forEach((dep) => {
                    c.log(`- ${dep}`);
                });
                break;

            case 'server':
                await commands.server();
                break;

            case 'runserver':
                await commands.runServer();
                break;
            case 'stopserver':
                await commands.stopServer();
                break;
            case 'autofix':
                await commands.autofix();
                c.log('Autofix applied.');
                break;

            case 'exit':
                return;

            default:
                c.warn('Unknown command.');
                break;
        }
        c.remLevel();
        c.log('');
    }

    if (debug) {
        c.log('Debug mode is enabled. Exiting without asking for command.');
    }
}

main().then();
