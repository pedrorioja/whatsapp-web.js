'use strict';

/* Require Optional Dependencies */
try {
    var fs = require('fs-extra');
    var unzipper = require('unzipper');
    var archiver = require('archiver');
} catch {
    fs = undefined;
    unzipper = undefined;
    archiver = undefined;
}

const path = require('path');
const { Events } = require('./../util/Constants');
const BaseAuthStrategy = require('./BaseAuthStrategy');
let afterAuthReadyTriggered = {}

/**
 * Remote-based authentication
 * @param {object} options - options
 * @param {object} options.store - Remote database store instance
 * @param {string} options.clientId - Client id to distinguish instances if you are using multiple, otherwise keep null if you are using only one instance
 * @param {string} options.dataPath - Change the default path for saving session files, default is: "./.wwebjs_auth/" 
 * @param {number} options.backupSyncIntervalMs - Sets the time interval for periodic session backups. Accepts values starting from 60000ms {1 minute}
 */
class RemoteAuth extends BaseAuthStrategy {
    constructor({ clientId, dataPath, store, backupSyncIntervalMs } = {}) {
        if (!fs && !unzipper && !archiver) throw new Error('Optional Dependencies [fs-extra, unzipper, archiver] are required to use RemoteAuth. Make sure to run npm install correctly and remove the --no-optional flag');
        super();

        const idRegex = /^[-_\w]+$/i;
        if (clientId && !idRegex.test(clientId)) {
            throw new Error('Invalid clientId. Only alphanumeric characters, underscores and hyphens are allowed.');
        }
        if (!backupSyncIntervalMs || backupSyncIntervalMs < 60000) {
            throw new Error('Invalid backupSyncIntervalMs. Accepts values starting from 60000ms {1 minute}.');
        }
        if(!store) throw new Error('Remote database store is required.');

        this.store = store;
        this.clientId = clientId;
        this.backupSyncIntervalMs = backupSyncIntervalMs;
        this.dataPath = path.resolve(dataPath || './.wwebjs_auth/');
        this.tempDir = `${this.dataPath}/wwebjs_temp_session_${this.clientId}`;
        this.requiredDirs = ['Default', 'IndexedDB', 'Local Storage']; /* => Required Files & Dirs in WWebJS to restore session */
    }

    async beforeBrowserInitialized() {
        const puppeteerOpts = this.client.options.puppeteer;
        const sessionDirName = this.clientId ? `RemoteAuth-${this.clientId}` : 'RemoteAuth';
        const dirPath = path.join(this.dataPath, sessionDirName);

        if (puppeteerOpts.userDataDir && puppeteerOpts.userDataDir !== dirPath) {
            throw new Error('RemoteAuth is not compatible with a user-supplied userDataDir.');
        }

        this.userDataDir = dirPath;
        this.sessionName = sessionDirName;

        await this.extractRemoteSession();

        this.client.options.puppeteer = {
            ...puppeteerOpts,
            userDataDir: dirPath
        };
    }

    async logout() {
        await this.disconnect();
    }

    async destroy() {
        console.log('(destroy remote auth) Triggered')
        clearInterval(this.backupSync);
        afterAuthReadyTriggered[this.sessionName] = false
        console.log('(destroy remote auth) Finished')
    }

    async disconnect() {
        await this.deleteRemoteSession();

        let pathExists = await this.isValidPath(this.userDataDir);
        if (pathExists) {
            await fs.promises.rm(this.userDataDir, {
                recursive: true,
                force: true
            }).catch(() => {});
        }
        clearInterval(this.backupSync);
    }

    async afterAuthReady() {
        console.log('After auth ready')
        console.log(afterAuthReadyTriggered)
        if (!afterAuthReadyTriggered[this.sessionName]){
            console.log('(After auth ready) ENTRÓ AL IF')
            afterAuthReadyTriggered[this.sessionName] = true
            const sessionExists = await this.store.sessionExists({session: this.sessionName});
            console.log(`(After auth ready) Session exists: ${sessionExists}`)
            if(!sessionExists) {
                console.log('(After auth ready) IF SESSION EXISTS')
                await this.delay(1000*30); /* Initial delay sync required for session to be stable enough to recover */
                console.log('(After auth ready) Delay ready')
                await this.storeRemoteSession({emit: true});
                console.log('(After auth ready) Store remote session ready')
            }
            var self = this;
            this.backupSync = setInterval(async function () {
                await self.storeRemoteSession();
            }, this.backupSyncIntervalMs);
        }
    }

    async storeRemoteSession(options) {
        /* Compress & Store Session */
        console.log('ENTRANDO A STORE REMOTE SESSION')
        const pathExists = await this.isValidPath(this.userDataDir);
        console.log(this.userDataDir)
        if (pathExists) {
            console.log('COMPRESS REMOTE SESSION')
            await this.compressSession();
            console.log('SAVE REMOTE SESSION')
            await this.store.save({session: this.sessionName});
            console.log('UNLINK')
            await fs.promises.unlink(`${this.dataPath}/${this.sessionName}.zip`);
            console.log('FS PROMISES')
            await fs.promises.rm(`${this.tempDir}`, {
                recursive: true,
                force: true
            }).catch(() => {});
            if(options && options.emit) this.client.emit(Events.REMOTE_SESSION_SAVED);
        }
    }

    async extractRemoteSession() {
        console.log("ENTRANDO A EXTRACT REMOTE SESSION")
        const pathExists = await this.isValidPath(this.userDataDir);
        const compressedSessionPath = `${this.dataPath}/${this.sessionName}.zip`;
        const sessionExists = await this.store.sessionExists({session: this.sessionName});
        if (pathExists) {
            await fs.promises.rm(this.userDataDir, {
                recursive: true,
                force: true
            }).catch(() => {});
        }
        if (sessionExists) {
            console.log('REMOTE AUTH: SESIÓN EXISTE')
            await this.store.extract({session: this.sessionName, path: compressedSessionPath});
            console.log('REMOTE AUTH: EXTRACT LISTO')
            await this.unCompressSession(compressedSessionPath);
            console.log('REMOTE AUTH: UNCOMPRESS LISTO')
        } else {
            fs.mkdirSync(this.userDataDir, { recursive: true });
        }
    console.log("SALIENDO DE EXTRACT REMOTE SESSION")
    }

    async deleteRemoteSession() {
        const sessionExists = await this.store.sessionExists({session: this.sessionName});
        if (sessionExists) await this.store.delete({session: this.sessionName});
    }

    async compressSession() {
        const archive = archiver('zip');
        const stream = fs.createWriteStream(`${this.dataPath}/${this.sessionName}.zip`);

        await fs.copy(this.userDataDir, this.tempDir).catch(() => {});
        await this.deleteMetadata();
        return new Promise((resolve, reject) => {
            archive
                .directory(this.tempDir, false)
                .on('error', err => reject(err))
                .pipe(stream);

            stream.on('close', () => resolve());
            archive.finalize();
        });
    }

    async unCompressSession(compressedSessionPath) {
        await(fs.createReadStream(compressedSessionPath).pipe(unzipper.Extract({ path: this.userDataDir })).promise())
    }

    async deleteMetadata() {
        const sessionDirs = [this.tempDir, path.join(this.tempDir, 'Default')];
        for (const dir of sessionDirs) {
            const sessionFiles = await fs.promises.readdir(dir);
            for (const element of sessionFiles) {
                if (!this.requiredDirs.includes(element)) {
                    const dirElement = path.join(dir, element);
                    const stats = await fs.promises.lstat(dirElement);
    
                    if (stats.isDirectory()) {
                        await fs.promises.rm(dirElement, {
                            recursive: true,
                            force: true
                        }).catch(() => {});
                    } else {
                        await fs.promises.unlink(dirElement).catch(() => {});
                    }
                }
            }
        }
    }

    async isValidPath(path) {
        try {
            await fs.promises.access(path);
            return true;
        } catch {
            return false;
        }
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = RemoteAuth;