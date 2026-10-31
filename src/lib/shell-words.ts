export class ShellWordsError extends Error {}

/**
 * Splits a command line into words the way a POSIX shell would for quoting:
 * single quotes are literal, double quotes allow \" and \\ escapes, and a
 * backslash outside quotes escapes the next character.
 */
export function splitShellWords(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let inWord = false;
	let i = 0;

	while (i < input.length) {
		const ch = input[i];

		if (/\s/.test(ch)) {
			if (inWord) {
				words.push(current);
				current = "";
				inWord = false;
			}
			i++;
			continue;
		}

		inWord = true;

		if (ch === "'") {
			const end = input.indexOf("'", i + 1);
			if (end === -1) throw new ShellWordsError("Unclosed single quote");
			current += input.slice(i + 1, end);
			i = end + 1;
			continue;
		}

		if (ch === '"') {
			i++;
			let closed = false;
			while (i < input.length) {
				const c = input[i];
				if (c === '"') {
					closed = true;
					i++;
					break;
				}
				if (c === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
					current += input[i + 1];
					i += 2;
					continue;
				}
				current += c;
				i++;
			}
			if (!closed) throw new ShellWordsError("Unclosed double quote");
			continue;
		}

		if (ch === "\\" && i + 1 < input.length) {
			current += input[i + 1];
			i += 2;
			continue;
		}

		current += ch;
		i++;
	}

	if (inWord) words.push(current);
	return words;
}
