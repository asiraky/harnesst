// Yours. Written once, when the channel was installed, and never touched by an update again —
// so anything you add here survives. The behaviour lives in `harnesst/github-channel.ts`, which
// is platform-owned and rewritten on every update; wake rules are set on the Deployment tab.
import { harnesstGitHubChannel } from "../../harnesst/github-channel";

export default harnesstGitHubChannel();
