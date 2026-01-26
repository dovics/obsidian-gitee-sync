import { Vault } from "obsidian";

export interface IgnoreRule {
	pattern: string;
	negation: boolean;
	regex: RegExp;
	isDirectoryOnly: boolean;
}

export default class GitignoreParser {
	private rules: IgnoreRule[] = [];
	private vault: Vault;

	constructor(vault: Vault) {
		this.vault = vault;
	}

	/**
	 * 加载并解析 .gitignore 文件
	 */
	async load(): Promise<void> {
		this.rules = [];
		const gitignorePath = ".gitignore";

		try {
			const exists = await this.vault.adapter.exists(gitignorePath);
			if (!exists) {
				return;
			}

			const content = await this.vault.adapter.read(gitignorePath);
			this.parseContent(content);
		} catch (err) {
			// 如果读取失败，忽略错误，使用空规则列表
			console.warn("Failed to load .gitignore:", err);
		}
	}

	/**
	 * 解析 .gitignore 文件内容
	 */
	private parseContent(content: string): void {
		const lines = content.split("\n");

		for (const line of lines) {
			const trimmedLine = line.trim();

			// 跳过空行和注释
			if (!trimmedLine || trimmedLine.startsWith("#")) {
				continue;
			}

			// 解析规则
			let pattern = trimmedLine;
			let negation = false;

			// 检查是否是否定规则（以 ! 开头）
			if (pattern.startsWith("!")) {
				negation = true;
				pattern = pattern.slice(1);
			}

			// 检查是否是仅目录规则（以 / 结尾）
			const isDirectoryOnly = pattern.endsWith("/");
			if (isDirectoryOnly) {
				pattern = pattern.slice(0, -1);
			}

			// 将 .gitignore 模式转换为正则表达式
			const regex = this.patternToRegex(pattern);

			this.rules.push({
				pattern: trimmedLine,
				negation,
				regex,
				isDirectoryOnly,
			});
		}
	}

	/**
	 * 将 .gitignore 模式转换为正则表达式
	 */
	private patternToRegex(pattern: string): RegExp {
		// 如果模式以 / 开头，表示从根目录开始匹配
		const anchored = pattern.startsWith("/");

		// 移除开头的 /，我们自己处理锚定
		let regexPattern = pattern.replace(/^\//, "");

		// 转义正则表达式特殊字符（除了 * 和 ?）
		const escapeRegex = /[.+^${}()|[\]\\]/g;
		regexPattern = regexPattern.replace(escapeRegex, "\\$&");

		// **/ 匹配零个或多个目录
		regexPattern = regexPattern.replace(/\*\*\//g, "(?:[^/]+/)*");

		// ** 匹配零个或多个字符（包括 /）
		regexPattern = regexPattern.replace(/\*\*/g, ".*");

		// * 匹配零个或多个非斜杠字符
		regexPattern = regexPattern.replace(/(?<!\*)\*(?!\*)/g, "[^/]*");

		// ? 匹配单个非斜杠字符
		regexPattern = regexPattern.replace(/\?/g, "[^/]");

		// 如果模式以 / 结尾，表示匹配目录
		if (pattern.endsWith("/")) {
			regexPattern += ".*";
		}

		// 构建最终的正则表达式
		if (anchored) {
			// 锚定到根目录
			return new RegExp(`^${regexPattern}(?:/|$)`);
		} else {
			// 可以匹配任何路径部分
			return new RegExp(`(?:^|/)${regexPattern}(?:/|$)`);
		}
	}

	/**
	 * 检查文件路径是否被 .gitignore 规则忽略
	 * @param filePath 文件路径（相对于 vault 根目录）
	 * @returns true 如果文件应该被忽略
	 */
	isIgnored(filePath: string): boolean {
		// 规范化路径
		const normalizedPath = filePath.replace(/\\/g, "/");

		let ignored = false;

		// 按顺序检查所有规则
		for (const rule of this.rules) {
			if (rule.regex.test(normalizedPath)) {
				if (rule.negation) {
					// 否定规则，取消忽略
					ignored = false;
				} else {
					// 正常忽略规则
					ignored = true;
				}
			}
		}

		return ignored;
	}

	/**
	 * 重新加载 .gitignore 文件
	 */
	async reload(): Promise<void> {
		await this.load();
	}

	/**
	 * 获取当前加载的规则数量
	 */
	getRulesCount(): number {
		return this.rules.length;
	}
}
