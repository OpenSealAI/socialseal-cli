/** Named-account public operations. Keep the CLI's vendored copy byte-identical. */
export const CREATOR_ACCOUNT_CONTRACT_VERSION = "creator_account_v1";
export const CREATOR_COLLECTION_CONTRACT_VERSION = "creator_account_collection_v1";
export const CREATOR_ACCOUNT_DEFAULT_POST_COUNT = 5;
export const CREATOR_ACCOUNT_REFRESH_CREDITS = 1;
export const CREATOR_ACCOUNT_OPERATIONS = [
  {
    mcpName: "socialseal_get_creator_profile", cliCommand: "profile", backend: "creator-account-read", action: "profile",
    title: "Read a named Instagram creator profile", access: "read", required: ["target", "platform"],
    optional: ["workspaceId", "recentPostCount", "brandId", "freshness"],
  },
  {
    mcpName: "socialseal_get_creator_recent_posts", cliCommand: "recent-posts", backend: "creator-account-read", action: "recent_posts",
    title: "Read recent Instagram account posts and engagement metrics", access: "read", required: ["target", "platform"],
    optional: ["workspaceId", "recentPostCount", "brandId", "freshness"],
  },
  {
    mcpName: "socialseal_collect_creator_account", cliCommand: "collect", backend: "creator-account-collect", action: "start",
    title: "Collect a named Instagram account once", access: "write", required: ["workspaceId", "target", "platform", "idempotencyKey", "maxCredits"],
    optional: ["recentPostCount", "brandId"],
  },
  {
    mcpName: "socialseal_get_creator_collection", cliCommand: "status", backend: "creator-account-collect", action: "status",
    title: "Read a named-account collection status and evidence", access: "read", required: ["workspaceId", "id"],
    optional: ["recentPostCount", "brandId"],
  },
];
export const CREATOR_ACCOUNT_EVIDENCE_SEMANTICS = {
  platforms: ["instagram"],
  eligibleMedia: ["image", "carousel", "video"],
  ordering: "Provider publication time descending, independent of pinned placement. Undated posts are separate; they prevent a verified latest-post claim.",
  averageViews: "Arithmetic mean over posts with available views, including zero; report denominator.",
  engagementByViews: "100 * (likes + comments) / views; require both components and positive views.",
  engagementByFollowers: "100 * (likes + comments) / profile followers at collection time; require both components and positive followers.",
  missing: "Unavailable is null, never zero. Shares and saves are excluded when unavailable. Mean per-post rates and ratio of totals are separate aggregates.",
  collection: "One bounded account profile refresh uses the existing monitoring-refresh credit-cap/refund policy. Explicit workspace, maxCredits=1, and durable idempotency key; no tracker. Reusing a key never re-executes a terminal receipt.",
  continuation: "If status=running, use socialseal_get_creator_collection or creator status with id and workspaceId. complete and failed are terminal execution states; evidence coverage is separate.",
  coverage: "A profile page ending is not proof of timeline completeness. Require explicit terminal pagination and matching unique account count with no invalid/undated entries. Otherwise label latest dated posts in available sample.",
  brandFit: "Host-owned assessment from accessible workspace brand context, profile and captions: distinguish observations, inference and missing evidence. Missing brand context does not block metrics. Public views do not establish demographics or unique reach.",
};
