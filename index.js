import process from 'node:process';
import os from 'node:os';
import tty from 'node:tty';

// Precompile regex patterns for terminal detection (optimization)
const TERM_256_REGEX = /-256(color)?$/i;
const TERM_BASIC_REGEX = /^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i;
const TEAMCITY_VERSION_REGEX = /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/;

// Cache for flag lookups (optimization)
const flagCache = new Map();

// From: https://github.com/sindresorhus/has-flag/blob/main/index.js
/// function hasFlag(flag, argv = globalThis.Deno?.args ?? process.argv) {
function hasFlag(flag, argv = globalThis.Deno ? globalThis.Deno.args : process.argv) {
	// Memoize flag detection (optimization)
	const cacheKey = `${flag}:${argv.join(':')}`;
	if (flagCache.has(cacheKey)) {
		return flagCache.get(cacheKey);
	}

	const prefix = flag.startsWith('-') ? '' : (flag.length === 1 ? '-' : '--');
	const position = argv.indexOf(prefix + flag);
	const terminatorPosition = argv.indexOf('--');
	const result = position !== -1 && (terminatorPosition === -1 || position < terminatorPosition);

	flagCache.set(cacheKey, result);
	return result;
}

const {env} = process;

// Cache flag force color detection (optimization)
let flagForceColor;
let cachedArgv = null;

function getFlagForceColor() {
	// Return cached value if argv hasn't changed (optimization)
	const currentArgv = globalThis.Deno ? globalThis.Deno.args : process.argv;
	if (cachedArgv === currentArgv && flagForceColor !== undefined) {
		return flagForceColor;
	}

	cachedArgv = currentArgv;

	if (
		hasFlag('no-color')
		|| hasFlag('no-colors')
		|| hasFlag('color=false')
		|| hasFlag('color=never')
	) {
		flagForceColor = 0;
	} else if (
		hasFlag('color')
		|| hasFlag('colors')
		|| hasFlag('color=true')
		|| hasFlag('color=always')
	) {
		flagForceColor = 1;
	} else {
		flagForceColor = undefined;
	}

	return flagForceColor;
}

function envForceColor() {
	if (!('FORCE_COLOR' in env)) {
		return;
	}

	if (env.FORCE_COLOR === 'true') {
		return 1;
	}

	if (env.FORCE_COLOR === 'false') {
		return 0;
	}

	if (env.FORCE_COLOR.length === 0) {
		return 1;
	}

	const level = Math.min(Number.parseInt(env.FORCE_COLOR, 10), 3);

	if (![0, 1, 2, 3].includes(level)) {
		return;
	}

	return level;
}

function translateLevel(level) {
	if (level === 0) {
		return false;
	}

	return {
		level,
		hasBasic: true,
		has256: level >= 2,
		has16m: level >= 3,
	};
}

// Cache for Windows version check (optimization)
let windowsVersionCache = null;

function getWindowsVersion() {
	if (windowsVersionCache !== null) {
		return windowsVersionCache;
	}

	const osRelease = os.release().split('.');
	windowsVersionCache = {
		major: Number(osRelease[0]),
		minor: Number(osRelease[1]),
		build: Number(osRelease[2]),
	};

	return windowsVersionCache;
}

// Helper: Check for terminal-specific color support (optimization)
function checkTerminalColorSupport(env) {
	if (env.COLORTERM === 'truecolor') {
		return 3;
	}

	if (env.TERM === 'xterm-kitty' || env.TERM === 'xterm-ghostty' || env.TERM === 'wezterm') {
		return 3;
	}

	if ('TERM_PROGRAM' in env) {
		const version = Number.parseInt((env.TERM_PROGRAM_VERSION || '').split('.')[0], 10);

		switch (env.TERM_PROGRAM) {
			case 'iTerm.app': {
				return version >= 3 ? 3 : 2;
			}

			case 'Apple_Terminal': {
				return 2;
			}
			// No default
		}
	}

	if (TERM_256_REGEX.test(env.TERM)) {
		return 2;
	}

	if (TERM_BASIC_REGEX.test(env.TERM)) {
		return 1;
	}

	if ('COLORTERM' in env) {
		return 1;
	}

	return 0;
}

// Helper: Check CI environment color support (optimization)
function checkCIColorSupport(env, min) {
	if (['GITHUB_ACTIONS', 'GITEA_ACTIONS', 'CIRCLECI'].some(key => key in env)) {
		return 3;
	}

	if (['TRAVIS', 'APPVEYOR', 'GITLAB_CI', 'BUILDKITE', 'DRONE'].some(sign => sign in env) || env.CI_NAME === 'codeship') {
		return 1;
	}

	return min;
}

// Helper: Check flag-based color level (optimization)
function checkFlagColorLevel(sniffFlags) {
	if (!sniffFlags) {
		return 0;
	}

	if (hasFlag('color=16m') || hasFlag('color=full') || hasFlag('color=truecolor')) {
		return 3;
	}

	if (hasFlag('color=256')) {
		return 2;
	}

	return 0;
}

function _supportsColor(haveStream, {streamIsTTY, sniffFlags = true} = {}) {
	const noFlagForceColor = envForceColor();
	let localFlagForceColor = getFlagForceColor();

	if (noFlagForceColor !== undefined) {
		localFlagForceColor = noFlagForceColor;
	}

	const forceColor = sniffFlags ? localFlagForceColor : noFlagForceColor;

	if (forceColor === 0) {
		return 0;
	}

	const flagLevel = checkFlagColorLevel(sniffFlags);
	if (flagLevel > 0) {
		return flagLevel;
	}

	// Check for Azure DevOps pipelines.
	// Has to be above the `!streamIsTTY` check.
	if ('TF_BUILD' in env && 'AGENT_NAME' in env) {
		return 1;
	}

	if (haveStream && !streamIsTTY && forceColor === undefined) {
		return 0;
	}

	const min = forceColor || 0;

	if (env.TERM === 'dumb') {
		return min;
	}

	if (process.platform === 'win32') {
		// Windows 10 build 10586 is the first Windows release that supports 256 colors.
		// Windows 10 build 14931 is the first release that supports 16m/TrueColor.
		const windowsVersion = getWindowsVersion();
		if (
			windowsVersion.major >= 10
			&& windowsVersion.build >= 10_586
		) {
			return windowsVersion.build >= 14_931 ? 3 : 2;
		}

		return 1;
	}

	if ('CI' in env) {
		return checkCIColorSupport(env, min);
	}

	if ('TEAMCITY_VERSION' in env) {
		return TEAMCITY_VERSION_REGEX.test(env.TEAMCITY_VERSION) ? 1 : 0;
	}

	// Check terminal-specific support
	const terminalLevel = checkTerminalColorSupport(env);
	if (terminalLevel > 0) {
		return terminalLevel;
	}

	return min;
}

export function createSupportsColor(stream, options = {}) {
	const level = _supportsColor(stream, {
		streamIsTTY: stream && stream.isTTY,
		...options,
	});

	return translateLevel(level);
}

// Export cache clearing function for testing/advanced use (optimization)
export function clearCache() {
	flagCache.clear();
	windowsVersionCache = null;
	cachedArgv = null;
	flagForceColor = undefined;
}

// Lazy initialization for stdout/stderr (optimization)
let stdoutCache = null;
let stderrCache = null;

const supportsColor = {
	get stdout() {
		if (stdoutCache === null) {
			stdoutCache = createSupportsColor({isTTY: tty.isatty(1)});
		}

		return stdoutCache;
	},

	get stderr() {
		if (stderrCache === null) {
			stderrCache = createSupportsColor({isTTY: tty.isatty(2)});
		}

		return stderrCache;
	},
};

export default supportsColor;
