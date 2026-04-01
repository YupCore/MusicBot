const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

class YtDlp {
    static getBinaryPath() {
        const projectRoot = path.join(__dirname, '..');
        const binDir = path.join(projectRoot, 'bin');
        const windowsBinary = path.join(binDir, 'yt-dlp.exe');
        const unixBinary = path.join(binDir, 'yt-dlp');

        if (process.platform === 'win32') {
            if (!fs.existsSync(windowsBinary)) {
                throw new Error(`yt-dlp binary not found at ${windowsBinary}`);
            }
            return windowsBinary;
        }

        if (fs.existsSync(unixBinary)) {
            return unixBinary;
        }

        if (fs.existsSync(windowsBinary)) {
            return windowsBinary;
        }

        throw new Error(`yt-dlp binary not found at ${windowsBinary} or ${unixBinary}`);
    }

    static getFfmpegLocation() {
        const projectRoot = path.join(__dirname, '..');
        return path.join(projectRoot, 'bin');
    }

    static toKebabCase(optionKey) {
        return optionKey.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    }

    static appendOption(args, key, value) {
        if (value === undefined || value === null || value === false) {
            return;
        }

        const flag = `--${this.toKebabCase(key)}`;

        if (value === true) {
            args.push(flag);
            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                args.push(flag, String(item));
            }
            return;
        }

        if (typeof value === 'object') {
            for (const [subKey, subValue] of Object.entries(value)) {
                if (Array.isArray(subValue)) {
                    if (key === 'postprocessorArgs') {
                        // yt-dlp expects postprocessor args as a single value per postprocessor,
                        // e.g. --postprocessor-args "ffmpeg:-c:a libopus -b:a 128k"
                        args.push(flag, `${subKey}:${subValue.join(' ')}`);
                    } else {
                        for (const val of subValue) {
                            args.push(flag, `${subKey}:${val}`);
                        }
                    }
                } else if (subValue !== undefined && subValue !== null && subValue !== false) {
                    args.push(flag, `${subKey}:${String(subValue)}`);
                }
            }
            return;
        }

        args.push(flag, String(value));
    }

    static buildArgs(urlOrQuery, options = {}) {
        const args = [];
        const mergedOptions = {
            jsRuntimes: 'node',
            ffmpegLocation: this.getFfmpegLocation(),
            ...options,
        };

        for (const [key, value] of Object.entries(mergedOptions)) {
            this.appendOption(args, key, value);
        }

        if (urlOrQuery !== undefined && urlOrQuery !== null && urlOrQuery !== '') {
            args.push(String(urlOrQuery));
        }

        return args;
    }

    static exec(args, execOptions = {}) {
        const binary = this.getBinaryPath();

        return new Promise((resolve, reject) => {
            execFile(binary, args, {
                windowsHide: true,
                maxBuffer: 64 * 1024 * 1024,
                timeout: 180000,
                ...execOptions,
            }, (error, stdout, stderr) => {
                if (error) {

                    const renderedCommand = `${binary} ${args.map((arg) => JSON.stringify(String(arg))).join(' ')}`;

                    console.error('[YtDlp] Command failed:', renderedCommand);
                    const stderrText = (stderr || '').toString().trim();
                    const stdoutText = (stdout || '').toString().trim();
                    const message = stderrText || stdoutText || error.message || 'yt-dlp execution failed';
                    const wrapped = new Error(message);
                    wrapped.cause = error;
                    wrapped.stdout = stdout;
                    wrapped.stderr = stderr;
                    return reject(wrapped);
                }

                resolve({
                    stdout: (stdout || '').toString(),
                    stderr: (stderr || '').toString(),
                });
            });
        });
    }

    static async run(urlOrQuery, options = {}, execOptions = {}) {
        const args = this.buildArgs(urlOrQuery, options);
        const { stdout } = await this.exec(args, execOptions);
        return stdout.trim();
    }

    static async runJson(urlOrQuery, options = {}, execOptions = {}) {
        const merged = {
            dumpSingleJson: true,
            ...options,
        };

        const output = await this.run(urlOrQuery, merged, execOptions);
        if (!output) {
            return null;
        }

        try {
            return JSON.parse(output);
        } catch (error) {
            const wrapped = new Error(`Failed to parse yt-dlp JSON output: ${error.message}`);
            wrapped.cause = error;
            wrapped.rawOutput = output;
            throw wrapped;
        }
    }

    static async download(urlOrQuery, options = {}, execOptions = {}) {
        await this.run(urlOrQuery, options, execOptions);
        return true;
    }
}

module.exports = YtDlp;
