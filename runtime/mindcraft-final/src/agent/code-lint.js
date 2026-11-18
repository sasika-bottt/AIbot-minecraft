import { ESLint } from 'eslint';

// Runtime code must be checked even in a fresh per-user directory. Never load
// executable ESLint configuration from a user's world or working directory.
const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: { console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' }
        },
        rules: {
            'no-undef': 'error',
            'no-unreachable': 'error',
            'no-dupe-args': 'error',
            'no-const-assign': 'error'
        }
    }
});

export function lintGeneratedCode(code) {
    return eslint.lintText(code, { filePath: 'minebot-generated.js' });
}
