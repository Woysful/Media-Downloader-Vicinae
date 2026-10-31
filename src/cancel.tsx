import { showToast, Toast } from "@vicinae/api";
import { cancelJob, listActiveJobs } from "./lib/jobs";

export default async function Cancel() {
	const jobs = listActiveJobs();
	if (!jobs.length) {
		await showToast({
			style: Toast.Style.Success,
			title: "No active downloads",
		});
		return;
	}

	const toast = await showToast({
		style: Toast.Style.Animated,
		title:
			jobs.length > 1
				? `Cancelling ${jobs.length} downloads…`
				: "Cancelling download…",
	});

	const results = await Promise.allSettled(jobs.map((job) => cancelJob(job)));
	const failed = results.filter((r) => r.status === "rejected");
	for (const f of failed)
		console.error("Cancel failed:", (f as PromiseRejectedResult).reason);

	toast.message = failed.length ? `${failed.length} could not be stopped` : "";
	toast.style = failed.length ? Toast.Style.Failure : Toast.Style.Success;
	toast.title =
		jobs.length > 1
			? `Cancelled ${jobs.length - failed.length} downloads`
			: "Download cancelled";
}
