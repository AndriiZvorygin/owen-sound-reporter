export function isSuccessfulPublishResponse(payload) {
  return payload?.ok === true
    && Boolean(String(payload?.post_url || payload?.article_url || payload?.transcript_url || "").trim());
}
