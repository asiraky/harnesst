import { githubChannel } from "eve/channels/github";

// GitHub App credentials come from the GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY /
// GITHUB_WEBHOOK_SECRET environment variables, and the bot name from
// GITHUB_APP_SLUG (set them as agent secrets in harnesst). @mention the app in an
// issue or pull-request comment to start a turn.
export default githubChannel({});
