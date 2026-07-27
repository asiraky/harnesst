/**
 * WS1 — the one seam between "which channel homes this session" and "how do we deliver into it".
 * Two of these tests pin runtime traps that cost a production run to find:
 *   - eve's `send()` RE-PREFIXES the channel name, so the token must be stored stripped exactly
 *     once (`github:repo:1:issue:2` → `repo:1:issue:2`, never `1:issue:2`);
 *   - `routePath` arrives from an agent container and later becomes an outbound URL, so it is
 *     allowlisted both on the way in and on the way out.
 */
import { describe, expect, it } from "vitest";

import {
  answerRouteFor,
  buildResumeVia,
  channelDeliveryFor,
  CHANNEL_ANSWER_ROUTES,
  isResumeChannel,
  stripChannelNamespace,
} from "~/foh/channel-resume";

const GITHUB_ROUTE = CHANNEL_ANSWER_ROUTES.github;

const STATE = { owner: "acme", repo: "widgets", issueNumber: 1 };

describe("stripChannelNamespace", () => {
  it("drops the channel namespace exactly once", () => {
    expect(stripChannelNamespace("github", "github:repo:1:issue:2")).toBe(
      "repo:1:issue:2",
    );
  });

  it("leaves a token that carries no namespace verbatim", () => {
    expect(stripChannelNamespace("github", "repo:1:issue:2")).toBe(
      "repo:1:issue:2",
    );
  });

  it("does not strip another channel's namespace", () => {
    expect(stripChannelNamespace("github", "discord:chan:1")).toBe(
      "discord:chan:1",
    );
  });
});

describe("the channel allowlist", () => {
  it("knows github and nothing else yet", () => {
    expect(isResumeChannel("github")).toBe(true);
    expect(isResumeChannel("slack")).toBe(false);
    expect(answerRouteFor("github")).toBe(GITHUB_ROUTE);
    expect(answerRouteFor("slack")).toBeNull();
  });
});

describe("buildResumeVia", () => {
  it("stores the stripped token alongside the channel's own route and state", () => {
    expect(
      buildResumeVia({
        channel: "github",
        routePath: GITHUB_ROUTE,
        continuationToken: "github:repo:1310524517:issue:1",
        state: STATE,
      }),
    ).toEqual({
      channel: "github",
      routePath: GITHUB_ROUTE,
      rawToken: "repo:1310524517:issue:1",
      state: STATE,
    });
  });

  it("refuses an unknown channel", () => {
    expect(
      buildResumeVia({
        channel: "slack",
        routePath: "/eve/v1/slack/harnesst/answer",
        continuationToken: "slack:c1",
        state: STATE,
      }),
    ).toBeNull();
  });

  it("refuses a route path that is not the one harnesst registers for the channel", () => {
    expect(
      buildResumeVia({
        channel: "github",
        routePath: "/eve/v1/session/evil",
        continuationToken: "github:repo:1:issue:1",
        state: STATE,
      }),
    ).toBeNull();
  });

  it("refuses an empty continuation token — there would be nothing to resume", () => {
    expect(
      buildResumeVia({
        channel: "github",
        routePath: GITHUB_ROUTE,
        continuationToken: "",
        state: STATE,
      }),
    ).toBeNull();
  });
});

describe("channelDeliveryFor", () => {
  const via = {
    channel: "github",
    routePath: GITHUB_ROUTE,
    rawToken: "repo:1:issue:1",
    state: STATE,
  };

  it("is null for an ordinary HTTP-homed session", () => {
    expect(channelDeliveryFor({ resumeVia: null }, "ednt_x.y")).toBeNull();
  });

  it("carries the stripped token, the route and the bearer", () => {
    expect(channelDeliveryFor({ resumeVia: via }, "ednt_x.y")).toEqual({
      routePath: GITHUB_ROUTE,
      rawToken: "repo:1:issue:1",
      state: STATE,
      bearer: "ednt_x.y",
    });
  });

  it("re-validates the stored route on the way out — a hand-edited row cannot redirect the POST", () => {
    expect(
      channelDeliveryFor(
        { resumeVia: { ...via, routePath: "http://attacker.example/x" } },
        "ednt_x.y",
      ),
    ).toBeNull();
    expect(
      channelDeliveryFor({ resumeVia: { ...via, channel: "slack" } }, "ednt_x.y"),
    ).toBeNull();
  });
});
