import { open, showToast, Toast } from "@vicinae/api";
import { loadDomainConfig } from "./lib/domain-config";
import { loadSettings } from "./lib/download";

export default async function ConfigureDomains() {
	try {
		const settings = loadSettings();
		const config = loadDomainConfig(settings.domainConfigDir);

		await open(config.path);

		if (config.warnings.length) {
			await showToast({
				style: Toast.Style.Failure,
				title: `domain-config.txt: ${config.warnings.length} problem(s)`,
				message: config.warnings.join("; "),
			});
		} else {
			await showToast({
				style: Toast.Style.Success,
				title: config.created
					? "Created domain-config.txt"
					: `${config.rules.length} domain rule(s)`,
				message: config.path,
			});
		}
	} catch (error) {
		await showToast({
			style: Toast.Style.Failure,
			title: "Could not open domain config",
			message: error instanceof Error ? error.message : String(error),
		});
	}
}
