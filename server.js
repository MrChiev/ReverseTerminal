const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');
const readline = require('readline');
const os = require('os');
const { execSync } = require('child_process');

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG_FILE = 'config.ini';
const BUILD = '202305171';

let config = {};
let osUrls = {};
let generatedKey = null;
let shellProcess = null;
let shellInput = null;

function loadConfig() {
    log('Loading config.ini...');

    // Parse simple key=value ini manually (avoids edge cases with the ini module on first run)
    let raw = {};
    if (fs.existsSync(CONFIG_FILE)) {
        const lines = fs.readFileSync(CONFIG_FILE, 'utf8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';') || trimmed.startsWith('[')) continue;
            const idx = trimmed.indexOf('=');
            if (idx === -1) continue;
            raw[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
        }
    }

    // Apply defaults for anything missing
    const defaults = {
        'USR-KEY':          'InputYourKeyHere',
        'OS':               'Default',
        'HOST-IP':          '0.0.0.0',
        'HOST-PORT':        process.env.SERVER_PORT  || '8080',
        'Public-IP':        process.env.SERVER_IP    || 'unknown',
        'Private-IP':       process.env.INTERNAL_IP  || 'unknown',
        'Startup-Command':  'bash',
        'Autorun-Command':  'NaN',
        'ENABLE-WEB_SHELL': 'False',
        'WEB-USERNAME':     'admin',
        'WEB-PASSWORD':     '12345',
        'REPO-RAW-URL':     'https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/resources',
    };

    for (const [k, v] of Object.entries(defaults)) {
        if (!(k in raw)) raw[k] = v;
    }

    config = raw;
    saveConfig();

    log('Config loaded:');
    log(`  Startup-Command  : ${cfg('Startup-Command')}`);
    log(`  Autorun-Command  : ${cfg('Autorun-Command')}`);
    log(`  Public-IP        : ${cfg('Public-IP')}`);
    log(`  HOST-IP          : ${cfg('HOST-IP')}`);
    log(`  HOST-PORT        : ${cfg('HOST-PORT')}`);
    log(`  ENABLE-WEB_SHELL : ${cfg('ENABLE-WEB_SHELL')}`);
    log(`  WEB-USERNAME     : ${cfg('WEB-USERNAME')}`);
    log(`  REPO-RAW-URL     : ${cfg('REPO-RAW-URL')}`);

    if (cfg('REPO-RAW-URL').includes('YOUR_USERNAME'))
        elog('WARNING: REPO-RAW-URL is still the default placeholder. Update it in config.ini!');
    if (cfg('WEB-PASSWORD') === '12345')
        elog('WARNING: WEB-PASSWORD is still the default. Change it in config.ini!');
}

function cfg(key) {
    return config[key] || '';
}

function setCfg(key, value) {
    config[key] = value;
    saveConfig();
}

function saveConfig() {
    const lines = Object.entries(config).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(CONFIG_FILE, lines.join('\n') + '\n', 'utf8');
}

// ─── Logging ───────────────────────────────────────────────────────────────

function log(text)  { console.log(`[INFO]  ${text}`); }
function elog(text) { console.log(`[ERROR] ${text}`); }

// ─── Shell subprocess ──────────────────────────────────────────────────────

function startShell() {
    shellProcess = spawn('bash', [], {
        stdio: ['pipe', 'inherit', 'inherit']
    });

    shellInput = shellProcess.stdin;

    shellProcess.on('exit', (code) => {
        elog(`Shell process exited with code ${code}`);
    });

    // Clean up on JVM exit
    process.on('exit', () => {
        if (shellProcess && !shellProcess.killed) shellProcess.kill();
    });
    process.on('SIGINT',  () => process.exit());
    process.on('SIGTERM', () => process.exit());
}

function writeCmd(cmd) {
    log(`[${cfg('WEB-USERNAME')}] $ ${cmd}`);
    shellInput.write(cmd + '\n');
}

// ─── Key generation ────────────────────────────────────────────────────────

function genKey() {
    try {
        const hostname = execSync('uname -n').toString().trim();
        const kernel   = execSync('uname -r').toString().trim();
        const digits   = (kernel + hostname + hostname + kernel)
            .replace(/[^0-9]/g, '');
        generatedKey = digits;
    } catch (e) {
        elog('Key generation failed: ' + e.message);
        generatedKey = '';
    }

    const stored = cfg('USR-KEY');
    if (!stored || stored === 'InputYourKeyHere' || stored !== generatedKey) {
        elog('No valid key found in config.ini.');
        log('Go to the Discord for key instructions: https://discord.com/invite/NJdrJwZxKa');
        log('==============================');
        try {
            log('[KEY GEN] Hostname : ' + execSync('uname -n').toString().trim());
            log('[KEY GEN] Kernel   : ' + execSync('uname -r').toString().trim());
        } catch (_) {}
        log('==============================');
    }

    return generatedKey;
}

function compareKey(input) {
    return input === generatedKey;
}

function validKey() {
    return cfg('USR-KEY') === generatedKey;
}

// ─── HTTP fetch helper ─────────────────────────────────────────────────────

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchUrl(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

// ─── OS database ───────────────────────────────────────────────────────────

async function fetchOsList() {
    const url = cfg('REPO-RAW-URL') + '/OSs.txt';
    log('Fetching OS database...');
    try {
        const text = await fetchUrl(url);
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const parts = trimmed.split(' ');
            if (parts.length < 2) continue;
            osUrls[parts[0]] = parts[1];
            if (parts[0] !== 'Main') log(`  Found OS: ${parts[0]}`);
        }
        log(`Available OSs: ${Object.keys(osUrls).filter(k => k !== 'Main').length}`);
        if (osUrls['Main'] && osUrls['Main'] !== BUILD)
            log('Update available! Use UpdateServer to upgrade.');
    } catch (e) {
        const msg = e.message;
        if (msg.includes('403'))
            elog('Access denied (403) — is your repo private? Go to GitHub → Settings → Make public');
        else if (msg.includes('404'))
            elog('OSs.txt not found (404) — does resources/OSs.txt exist in your repo?');
        else
            elog('Could not fetch OS database: ' + msg);
        elog('URL tried: ' + url);
    }
}

// ─── Install wizard ────────────────────────────────────────────────────────

function installOS(osName, reset) {
    const url = osUrls[osName];
    if (!url) { elog('OS not found: ' + osName); return; }

    const archiveFile = url.endsWith('.tar.xz') ? '1.tar.xz' : '1.tar.gz';
    const downloadAndExtract =
        `curl -# -SLo ${archiveFile} ${url}` +
        ` && tar tf ${archiveFile} > /dev/null 2>&1` +
        ` || { echo '[ERROR] Download failed or corrupt archive — check OSs.txt'; rm -f ${archiveFile}; exit 1; }` +
        ` && cd $HOME && tar xvf ${archiveFile} && rm ${archiveFile}` +
        ` && echo "[Server INFO] Installation done!" && proot -S . bash`;

    log('Installing ' + osName);
    if (!reset) {
        writeCmd(downloadAndExtract);
    } else {
        writeCmd(
            `ls | grep -v linux | grep -v config.ini | grep -v server.js | grep -v node_modules` +
            ` | xargs rm -rf && ` + downloadAndExtract
        );
    }
    setCfg('OS', osName);
    setCfg('Startup-Command', 'proot -S . bash');
}

function installApp(apps) {
    if (cfg('OS') === 'Default') {
        // No proot — use apth directly
        writeCmd(`apth ${apps}`);
    } else {
        writeCmd(`apt-get update && apt-get install -y ${apps}`);
    }
    writeCmd(`export LINE1=$(find $HOME/linux -type d | awk '{printf "%s:", $0}') && export LD_LIBRARY_PATH=$LINE1 && export LIBRARY_PATH=$LINE1`);
}

function installShellWeb() {
    const gottyInstalled = fs.existsSync('linux/usr/bin/gotty');
    log('GOTTY installed: ' + gottyInstalled);
    if (!gottyInstalled) {
        writeCmd(
            `curl -# -SLo gotty.tar.gz https://github.com/yudai/gotty/releases/latest/download/gotty_linux_amd64.tar.gz` +
            ` && tar xf gotty.tar.gz -C $HOME/linux/usr/bin && chmod +x $HOME/linux/usr/bin/gotty && rm gotty.tar.gz`
        );
    }
    writeCmd(`nohup gotty -w -p ${cfg('HOST-PORT')} -c "${cfg('WEB-USERNAME')}:${cfg('WEB-PASSWORD')}" bash &`);
}

function setupRDP() {
    log('Setting up RDP (xfce4 + xrdp)...');
    if (cfg('OS') === 'Default') {
        elog('RDP requires an installed OS. Run: install Ubuntu-22');
        return;
    }
    writeCmd('apt-get update && apt-get install -y xfce4 xfce4-goodies xrdp dbus-x11 --no-install-recommends');
    writeCmd('adduser xrdp ssl-cert 2>/dev/null || true');
    writeCmd(`echo "xfce4-session" > ~/.xsession`);
    writeCmd('service xrdp start || xrdp');
    log('RDP setup complete!');
    log(`Connect via Remote Desktop to: ${cfg('Public-IP')}:3389`);
    log('Username: root  |  Password: (set one with: passwd root)');
}

function resetContainer() {
    log('Resetting container...');
    const files = fs.readdirSync('.');
    for (const f of files) {
        if (f === 'config.ini' || f === 'server.js' || f === 'package.json' || f === 'node_modules') continue;
        try { fs.rmSync(f, { recursive: true }); } catch (_) {}
    }
    ['linux/usr/bin', 'linux/bin', 'linux/usr/sbin', 'linux/sbin'].forEach(d =>
        fs.mkdirSync(d, { recursive: true })
    );
    const apthUrl = cfg('REPO-RAW-URL') + '/apth.txt';
    writeCmd(
        `curl -f -o $HOME/linux/bin/apth ${apthUrl}` +
        ` && head -1 $HOME/linux/bin/apth | grep -q '^#!'` +
        ` || { echo '[ERROR] apth download failed — check REPO-RAW-URL'; rm -f $HOME/linux/bin/apth; }` +
        ` && chmod +x $HOME/linux/bin/apth`
    );
    setCfg('Startup-Command', 'bash');
    setCfg('Autorun-Command', 'NaN');
    setCfg('OS', 'Default');
    elog('Reset complete — please restart.');
}

function uninstallOS() {
    const files = fs.readdirSync('.');
    for (const f of files) {
        if (['config.ini', 'server.js', 'package.json', 'node_modules', 'linux'].includes(f)) continue;
        try { fs.rmSync(f, { recursive: true }); } catch (_) {}
    }
    setCfg('Startup-Command', 'bash');
    setCfg('OS', 'Default');
    log('OS uninstalled.');
}

async function updateServer() {
    const remoteVersion = osUrls['Main'];
    if (!remoteVersion) { elog('OS database not loaded, cannot check for updates.'); return; }
    if (remoteVersion === BUILD) { log('Already up to date. Build: ' + BUILD); return; }

    log(`Update available: ${BUILD} → ${remoteVersion}`);
    const url = cfg('REPO-RAW-URL') + '/server.js';
    writeCmd(
        `curl -f -o server-new.js ${url}` +
        ` && mv server.js server-bak.js && mv server-new.js server.js` +
        ` && echo "[Server INFO] Update complete — please restart!"`
    );
}

// ─── Help ──────────────────────────────────────────────────────────────────

function logHelp() {
    log('Available commands:');
    log('  ListOS              - List available OSs to install');
    log('  install <OS>        - Install an OS');
    log('  reinstall           - Reinstall the current OS (wipes data)');
    log('  UnInstallOS         - Uninstall current OS');
    log('  ResetOS             - Full container reset');
    log('  InstallApp <pkgs>   - Install packages (space separated)');
    log('  AptUpgrade          - Run apt-get upgrade');
    log('  SetupRDP            - Install xfce4 + xrdp for Remote Desktop');
    log('  UpdateServer        - Update server.js from repo');
    log('  ReloadCFG           - Reload config.ini');
    log('  RunShellInWeb       - Open browser terminal via gotty');
    log('  Console             - Direct shell passthrough (ConsoleExit to return)');
    log('  CloseIT             - Exit');
}

// ─── Input handler ─────────────────────────────────────────────────────────

function startInputHandler() {
    const rl = readline.createInterface({ input: process.stdin });

    if (cfg('ENABLE-WEB_SHELL').toLowerCase() === 'true') {
        installShellWeb();
    }

    log('Input handler ready. Type Help for available commands.');

    rl.on('line', async (line) => {
        const input = line.trim();
        const lower = input.toLowerCase();

        if (lower === 'help') {
            log('===============================================');
            logHelp();
            log('===============================================');

        } else if (lower === 'listos') {
            log('==========Available OS List============');
            let i = 0;
            for (const key of Object.keys(osUrls)) {
                if (key === 'Main') continue;
                log(`${++i}. ${key}`);
            }
            log('=======================================');

        } else if (lower.startsWith('install ')) {
            const osName = input.slice(8).trim();
            if (!osName) { elog('Usage: install <OSName>'); return; }
            if (!osUrls[osName]) { elog('OS not found: ' + osName); return; }
            installOS(osName, false);

        } else if (lower === 'reinstall') {
            const currentOS = cfg('OS');
            if (currentOS !== 'Default') {
                installOS(currentOS, true);
            } else {
                elog('No OS installed — nothing to reinstall.');
            }

        } else if (lower === 'uninstallos') {
            if (cfg('OS') !== 'Default') {
                uninstallOS();
            } else {
                elog('Default container cannot be uninstalled.');
            }

        } else if (lower === 'aptupgrade') {
            if (cfg('OS') !== 'Default') {
                writeCmd('apt-get update && apt-get upgrade -y');
            } else {
                elog('Not available in Default container.');
            }

        } else if (lower.startsWith('installapp ')) {
            const apps = input.slice(11).trim();
            installApp(apps);

        } else if (lower === 'setuprdp') {
            setupRDP();

        } else if (lower === 'resetos') {
            resetContainer();

        } else if (lower === 'updateserver') {
            await updateServer();

        } else if (lower === 'reloadcfg') {
            log('Reloading config.ini...');
            loadConfig();

        } else if (lower === 'runshellInweb' || lower === 'runshellinweb') {
            installShellWeb();

        } else if (lower === 'console') {
            log('Entering direct console mode. Type ConsoleExit to return.');
            const consoleHandler = (cmd) => {
                if (cmd.trim().toLowerCase() === 'consoleexit') {
                    log('Returned from console mode.');
                    rl.removeListener('line', consoleHandler);
                    rl.on('line', mainHandler);
                } else {
                    writeCmd(cmd);
                }
            };
            rl.removeListener('line', mainHandler);
            rl.on('line', consoleHandler);

        } else if (lower === 'closeit') {
            log('Goodbye!');
            process.exit(0);

        } else {
            elog(`Unknown command: ${input}`);
            log("Type 'Help' for available commands.");
        }
    });

    // Store reference so console mode can swap it out
    function mainHandler(line) {} // placeholder — rl.on('line') above is the real one
}

// ─── Auth loop ─────────────────────────────────────────────────────────────

function authLoop() {
    genKey();

    if (validKey()) {
        afterAuth();
        return;
    }

    elog('Key not found or invalid in config.ini.');
    log('Visit https://discord.com/invite/NJdrJwZxKa for your key.');
    log('Enter your key:');

    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
        const input = line.trim();
        if (compareKey(input)) {
            log('Key accepted. Saving...');
            setCfg('USR-KEY', input);
            rl.close();
            afterAuth();
        } else {
            elog('Wrong key — please try again:');
        }
    });
}

function afterAuth() {
    log('Key verified.');
    log('=================================================');
    log('  REVERSE TERMINAL V2  |  Build ' + BUILD);
    log('=================================================');
    logHelp();
    log('=================================================');
    startInputHandler();
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

async function main() {
    log('ReverseTerminal | Beta 2 (Node.js port) | Build: ' + BUILD);
    log('Starting up...');

    // Ensure base directory structure
    ['linux/usr/bin', 'linux/bin', 'linux/usr/sbin', 'linux/sbin']
        .forEach(d => fs.mkdirSync(d, { recursive: true }));

    startShell();
    loadConfig();

    // Export environment into shell
    writeCmd(
        `export HOST_IP=${cfg('HOST-IP')}` +
        ` && export HOST_PORT=${cfg('HOST-PORT')}` +
        ` && export LINE1=$(find $HOME/linux -type d | awk '{printf "%s:", $0}')` +
        ` && export LD_LIBRARY_PATH=$LINE1` +
        ` && export LIBRARY_PATH=$LINE1` +
        ` && export PATH=$LINE1:$PATH` +
        ` && bash`
    );

    // Bootstrap apth if not installed
    const apthPath = 'linux/bin/apth';
    if (!fs.existsSync(apthPath)) {
        log('First run: installing apth and proot...');
        const apthUrl = cfg('REPO-RAW-URL') + '/apth.txt';
        writeCmd(
            `curl -f -o $HOME/linux/bin/apth ${apthUrl}` +
            ` && head -1 $HOME/linux/bin/apth | grep -q '^#!'` +
            ` || { echo '[ERROR] apth download failed — check REPO-RAW-URL and make repo public'; rm -f $HOME/linux/bin/apth; }` +
            ` && curl -f -o $HOME/linux/bin/systemctl https://raw.githubusercontent.com/gdraheim/docker-systemctl-replacement/master/files/docker/systemctl3.py` +
            ` || echo '[ERROR] systemctl shim download failed'`
        );
        writeCmd('chmod +x $HOME/linux/bin/apth && $HOME/linux/bin/apth proot wget');
    } else {
        log('apth/proot already installed — skipping bootstrap.');
    }

    // Run startup command
    writeCmd(cfg('Startup-Command'));

    // Run autorun if set
    const autorun = cfg('Autorun-Command');
    if (autorun && autorun !== 'NaN') {
        writeCmd(`nohup ${autorun} &`);
    }

    await fetchOsList();

    log('Generating license key...');
    authLoop();
}

main().catch(e => {
    elog('Fatal error: ' + e.message);
    process.exit(1);
});
