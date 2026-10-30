#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readPyaTextValues } from '../../../../command/pya_lookup.mjs';
import {
  buildSupportingAttachmentMirrorPlan,
  DEFAULT_ATTACHMENT_ENDPOINT,
  mirrorSupportingAttachments,
  rewriteSupportingAttachmentUrls,
} from '../../../../program/library/reporter_shared/supporting-attachment-mirror.mjs';
import { verifyAgendaMotionAttributions } from '../../../../program/library/reporter_shared/motion-attribution-verifier.mjs';
import { canonicalMeetingRouteSlug } from '../../../../program/library/reporter_shared/meeting-route.mjs';

const DEFAULT_ENDPOINT = 'https://helpos.ca/api/helpos/v1/meeting-publish';

function parseDotEnvText(src) {
  const out = {};
  const lines = String(src || '').split(/\r?\n/u);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readEnvFileIfExists(filePath) {
  if (!filePath) return {};
  if (!fs.existsSync(filePath)) return {};
  return parseDotEnvText(fs.readFileSync(filePath, 'utf8'));
}

function loadEnvFallbacks(cwdDir) {
  const start = path.resolve(cwdDir);
  const dirs = [];
  let cur = start;
  while (true) {
    dirs.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // Merge from root -> cwd so nearer .env overrides outer/global values.
  const merged = {};
  for (const dir of dirs.reverse()) {
    Object.assign(merged, readEnvFileIfExists(path.join(dir, '.env')));
  }
  // Also include house-local env if running from repo root.
  Object.assign(merged, readEnvFileIfExists(path.join(cwdDir, 'world/house/owen-sound-reporter/.env')));
  return merged;
}

function loadSecretTokenFallback(cwdDir) {
  const candidates = [
    path.join(cwdDir, 'configure/secret.pya'),
    path.join(path.resolve(cwdDir, '..'), 'configure/secret.pya'),
    path.join(path.resolve(cwdDir, '../..'), 'configure/secret.pya'),
    path.join(path.resolve(cwdDir, '../../..'), 'configure/secret.pya'),
    path.join(path.resolve(cwdDir, '../../../..'), 'configure/secret.pya'),
    '/home/htaf/pyash/configure/secret.pya',
  ];
  for (const secretPath of candidates) {
    if (!secretPath || !fs.existsSync(secretPath)) continue;
    const values = readPyaTextValues(secretPath, [
      'meeting publish auth token',
      'helpos publish auth token',
      'MEETING_PUBLISH_AUTH_TOKEN',
      'HELPOS_PUBLISH_AUTH_TOKEN',
      'publish auth token',
    ]);
    for (const key of Object.keys(values)) {
      const token = String(values[key] || '').trim();
      if (token) return { token, source: `secret_pya:${secretPath}:${key}` };
    }
  }
  return { token: '', source: '' };
}

function usage() {
  return [
    'Usage: node program/publish-meeting-to-helpos-from-payload.mjs <lemmy_payload_json> [community_name] [idempotency_key] [post_ref] [extras_json] [dry_run]',
    'Examples:',
    '  node ... transcript/meeting-qwen-auto-normalized.lemmy-post.json owensound',
    '  node ... transcript/...lemmy-post.json owensound owen-sound-council-2026-03-23-v2 https://lemmy.ca/post/3540',
  ].join('\n');
}

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'unknown';
}

function resolveMaybeRelative(baseDir, rawPath) {
  const p = String(rawPath || '').trim();
  if (!p) return '';
  if (path.isAbsolute(p)) return p;
  return path.resolve(baseDir, p);
}

function parsePostRef(postRefRaw) {
  const postRef = String(postRefRaw || '').trim();
  if (!postRef) return { post_id: '', post_url: '' };
  if (/^\d+$/u.test(postRef)) return { post_id: String(Number(postRef)), post_url: '' };
  if (/^https?:\/\//iu.test(postRef)) return { post_id: '', post_url: postRef };
  return { post_id: '', post_url: '' };
}

function buildIdempotencyKey({ jurisdiction, body, dateIso, postTitle, postBody, explicit }) {
  const ex = String(explicit || '').trim();
  if (ex) return ex;
  const base = `${slugify(jurisdiction)}-${slugify(body)}-${String(dateIso || '').trim() || 'unknown-date'}`;
  const digest = crypto
    .createHash('sha256')
    .update(`${String(postTitle || '')}\n${String(postBody || '')}`, 'utf8')
    .digest('hex')
    .slice(0, 8);
  return `${base}-${digest}-v1`;
}

function extractCanonicalHref(html) {
  const m = String(html || '').match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/iu);
  return m ? String(m[1]).trim() : '';
}

function hasMetaDescription(html) {
  return /<meta\s+name=["']description["']\s+content=["'][^"']+["']/iu.test(String(html || ''));
}

function hasTitleTag(html) {
  return /<title>[\s\S]*?<\/title>/iu.test(String(html || ''));
}

function stripDisallowedTags(html) {
  let out = String(html || '');
  out = out.replace(/<script\b[\s\S]*?<\/script>/giu, '');
  out = out.replace(/<iframe\b[\s\S]*?<\/iframe>/giu, '');
  out = out.replace(/<object\b[\s\S]*?<\/object>/giu, '');
  out = out.replace(/\son[a-z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/giu, '');
  return out;
}

function ensureDiscussionPlaceholder(html) {
  const src = String(html || '');
  if (src.includes('{{DISCUSSION_URL}}')) return src;

  const discussionAnchor = /(<section[^>]+id=["']discussion["'][\s\S]*?<a[^>]+href=["'])([^"']*)(["'])/iu;
  if (discussionAnchor.test(src)) {
    return src.replace(discussionAnchor, `$1{{DISCUSSION_URL}}$3`);
  }

  if (/<\/main>/iu.test(src)) {
    return src.replace(/<\/main>/iu, '<p><a href="{{DISCUSSION_URL}}">Discuss this meeting on HelpOS</a></p>\n</main>');
  }
  if (/<\/body>/iu.test(src)) {
    return src.replace(/<\/body>/iu, '<p><a href="{{DISCUSSION_URL}}">Discuss this meeting on HelpOS</a></p>\n</body>');
  }
  return `${src}\n<p><a href="{{DISCUSSION_URL}}">Discuss this meeting on HelpOS</a></p>\n`;
}

function parseExtras(raw) {
  const txt = String(raw || '').trim();
  if (!txt) return null;
  if (txt.startsWith('@')) {
    const fp = path.resolve(process.cwd(), txt.slice(1));
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  }
  return JSON.parse(txt);
}

function toAbsUrl(siteUrl, jurisdiction, body, dateIso) {
  return `${String(siteUrl || 'https://helpos.ca').replace(/\/+$/u, '')}/transcripts/${slugify(jurisdiction)}/${slugify(body)}/${dateIso}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function imageProbe(imagePath) {
  const out = { path: imagePath, width: 0, height: 0, bytes: 0, mime: '' };
  if (!imagePath || !fs.existsSync(imagePath)) return out;
  try {
    out.bytes = fs.statSync(imagePath).size;
  } catch {}
  const ext = path.extname(imagePath).toLowerCase();
  out.mime = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream');
  try {
    const identify = execFileSync('identify', ['-format', '%w %h', imagePath], { encoding: 'utf8' }).trim();
    const m = identify.match(/^(\d+)\s+(\d+)$/u);
    if (m) {
      out.width = Number(m[1]) || 0;
      out.height = Number(m[2]) || 0;
    }
  } catch {}
  return out;
}

function prepareUploadCoverImage(imageSourcePath, payloadDir) {
  if (!imageSourcePath || !fs.existsSync(imageSourcePath)) return { uploadPath: '', probe: null, converted: false, originalProbe: null };
  const originalProbe = imageProbe(imageSourcePath);
  const ext = path.extname(imageSourcePath).toLowerCase();
  if (ext !== '.png') {
    return { uploadPath: imageSourcePath, probe: originalProbe, converted: false, originalProbe };
  }

  const jpegPath = path.join(payloadDir, `${path.basename(imageSourcePath, ext)}.meeting-publish-cover.jpg`);
  try {
    execFileSync('ffmpeg', ['-y', '-i', imageSourcePath, '-frames:v', '1', '-q:v', '3', jpegPath], {
      stdio: 'ignore',
    });
    if (fs.existsSync(jpegPath) && fs.statSync(jpegPath).size > 0) {
      const probe = imageProbe(jpegPath);
      return { uploadPath: jpegPath, probe, converted: true, originalProbe };
    }
  } catch {}

  return { uploadPath: imageSourcePath, probe: originalProbe, converted: false, originalProbe };
}

function parseRetryAfterMs(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) return 0;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  const when = Date.parse(raw);
  if (!Number.isFinite(when)) return 0;
  return Math.max(0, when - Date.now());
}

function isRateLimited(status, parsedBody) {
  if (Number(status) === 429) return true;
  const err = String(parsedBody?.error || '').trim().toLowerCase();
  return err === 'rate_limit_error';
}

function isLemmyLoginFailure(parsedBody) {
  const err = String(parsedBody?.error || '').trim().toLowerCase();
  return err.includes('failed lemmy login');
}

function isFailedIdempotencyKey(parsedBody) {
  const err = String(parsedBody?.error || '').trim().toLowerCase();
  return err.includes('idempotency_key already used for failed request');
}

function withAttemptSuffix(idempotencyKeyBase, attempt) {
  const base = String(idempotencyKeyBase || '').trim();
  if (!base) return '';
  const n = Number(attempt) || 1;
  return n <= 1 ? base : `${base}-r${n}`;
}

async function main() {
  const payloadArg = process.argv[2];
  const communityArg = process.argv[3] || '';
  const idempotencyArg = process.argv[4] || '';
  const postRefArg = process.argv[5] || '';
  const extrasArg = process.argv[6] || '';
  const dryRunArg = process.argv[7] || '';

  if (!payloadArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const endpoint = String(process.env.MEETING_PUBLISH_ENDPOINT || DEFAULT_ENDPOINT).trim();
  const envFallback = loadEnvFallbacks(process.cwd());
  const secretToken = loadSecretTokenFallback(process.cwd());
  const token = String(
    process.env.MEETING_PUBLISH_AUTH_TOKEN
    || process.env.HELPOS_PUBLISH_AUTH_TOKEN
    || process.env.PUBLISH_AUTH_TOKEN
    || envFallback.MEETING_PUBLISH_AUTH_TOKEN
    || envFallback.HELPOS_PUBLISH_AUTH_TOKEN
    || envFallback.PUBLISH_AUTH_TOKEN
    || secretToken.token
    || ''
  ).trim();
  const dryRun = /^(1|true|yes)$/iu.test(String(process.env.MEETING_PUBLISH_DRY_RUN || dryRunArg || '0'));
  const maxAttempts = Math.max(
    1,
    Number.parseInt(String(process.env.MEETING_PUBLISH_MAX_ATTEMPTS || envFallback.MEETING_PUBLISH_MAX_ATTEMPTS || '8'), 10) || 8
  );
  const baseRetryDelayMs = Math.max(
    1_000,
    Number.parseInt(String(process.env.MEETING_PUBLISH_RETRY_DELAY_MS || envFallback.MEETING_PUBLISH_RETRY_DELAY_MS || '105000'), 10) || 105_000
  );
  const retryJitterMs = Math.max(
    0,
    Number.parseInt(String(process.env.MEETING_PUBLISH_RETRY_JITTER_MS || envFallback.MEETING_PUBLISH_RETRY_JITTER_MS || '5000'), 10) || 5_000
  );

  const payloadPath = path.resolve(process.cwd(), payloadArg);
  const payloadDir = path.dirname(payloadPath);
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));

  const jurisdiction = String(payload?.jurisdiction || '').trim();
  const body = String(payload?.body || '').trim();
  const meetingRouteSlug = canonicalMeetingRouteSlug(payload?.meeting_route_slug || body);
  const dateIso = String(payload?.date_iso || '').trim();
  const postTitle = String(payload?.title || '').trim();
  let postBody = String(payload?.body_markdown || '').trim();
  const communityName = String(process.env.MEETING_PUBLISH_COMMUNITY_NAME || envFallback.MEETING_PUBLISH_COMMUNITY_NAME || communityArg || payload?.community_name || '').trim();
  const communityId = String(
    process.env.MEETING_PUBLISH_COMMUNITY_ID
    || envFallback.MEETING_PUBLISH_COMMUNITY_ID
    || payload?.community_id
    || ''
  ).trim();
  const siteUrl = String(process.env.MEETING_PUBLISH_SITE_URL || envFallback.MEETING_PUBLISH_SITE_URL || 'https://helpos.ca').trim();

  if (!jurisdiction || !body || !dateIso || !postTitle || !postBody) {
    throw new Error('payload missing required fields: jurisdiction/body/date_iso/title/body_markdown');
  }

  const artifactPrefix = path.basename(payloadPath).replace(/\.lemmy-post\.json$/u, '');
  const motionAttributionGate = verifyAgendaMotionAttributions({
    agendaSummaryPyaPath: path.join(payloadDir, `${artifactPrefix}.agenda-summary.pya`),
    sectionGroundingPyaPath: path.join(payloadDir, `${artifactPrefix}.agenda.section-grounding.pya`),
  });
  if (!motionAttributionGate.ok) {
    const details = motionAttributionGate.defects
      .slice(0, 8)
      .map((defect) => `${defect.unit_id}:${defect.field}:${defect.claim}`)
      .join('; ');
    throw new Error(`publish blocked: unsupported named motion attribution (${details})`);
  }

  const postRefEnv = String(process.env.MEETING_PUBLISH_POST_REF || envFallback.MEETING_PUBLISH_POST_REF || '').trim();
  const parsedRef = parsePostRef(postRefEnv || postRefArg || payload?.post_id || payload?.post_url || '');
  const updateMode = Boolean(parsedRef.post_id || parsedRef.post_url);

  if (!updateMode && !communityName && !/^\d+$/u.test(communityId)) {
    throw new Error('CREATE mode requires community_name or community_id');
  }

  const htmlSourcePath = resolveMaybeRelative(payloadDir, payload?.local_transcript_html);
  if (!htmlSourcePath || !fs.existsSync(htmlSourcePath)) {
    throw new Error(`transcript html not found: ${String(payload?.local_transcript_html || '')}`);
  }
  const imageSourcePath = resolveMaybeRelative(payloadDir, payload?.local_cover_image);
  const preparedCover = prepareUploadCoverImage(imageSourcePath, payloadDir);
  const uploadCoverPath = preparedCover.uploadPath || imageSourcePath;
  const alternateCoverPath = (
    preparedCover?.converted &&
    imageSourcePath &&
    fs.existsSync(imageSourcePath) &&
    path.resolve(preparedCover.uploadPath || "") !== path.resolve(imageSourcePath)
  ) ? imageSourcePath : "";

  let html = fs.readFileSync(htmlSourcePath, 'utf8');
  html = stripDisallowedTags(html);
  html = ensureDiscussionPlaceholder(html);

  if (!hasTitleTag(html)) throw new Error('transcript_html missing <title>');
  if (!hasMetaDescription(html)) throw new Error('transcript_html missing meta description');

  const expectedCanonical = String(payload?.transcript_url || toAbsUrl(siteUrl, jurisdiction, meetingRouteSlug, dateIso)).trim();
  const foundCanonical = extractCanonicalHref(html);
  if (!foundCanonical) throw new Error('transcript_html missing canonical link');
  if (foundCanonical !== expectedCanonical) {
    throw new Error(`canonical mismatch: found=${foundCanonical} expected=${expectedCanonical}`);
  }

  const attachmentIndexPath = resolveMaybeRelative(payloadDir, payload?.local_attachment_index);
  const sourceAttachments = Array.isArray(payload?.local_source_attachments) ? payload.local_source_attachments : [];
  const attachmentPlan = buildSupportingAttachmentMirrorPlan({ payloadDir, attachmentIndexPath, sourceAttachments });
  if (Array.isArray(attachmentPlan.unavailable) && attachmentPlan.unavailable.length) {
    process.stdout.write(
      `[meeting-publish] unavailable supporting attachments omitted from mirror: ${attachmentPlan.unavailable.length}\n`,
    );
  }
  process.stdout.write(`[meeting-publish] supporting attachments: ${attachmentPlan.length}\n`);
  if (!dryRun && attachmentPlan.length) {
    if (!token) throw new Error('MEETING_PUBLISH_AUTH_TOKEN is required to mirror attachments');
    const mirrored = await mirrorSupportingAttachments({
      payloadDir,
      attachmentIndexPath,
      sourceAttachments,
      endpoint: String(
        process.env.ATTACHMENT_PUBLISH_ENDPOINT
        || envFallback.ATTACHMENT_PUBLISH_ENDPOINT
        || DEFAULT_ATTACHMENT_ENDPOINT
      ).trim(),
      token,
      jurisdiction,
      body: meetingRouteSlug,
      dateIso,
      responsePath: path.join(
        payloadDir,
        `${path.basename(payloadPath, path.extname(payloadPath))}.supporting-attachments.mirror.response.json`,
      ),
      log: (message) => process.stdout.write(`${message}\n`),
    });
    postBody = rewriteSupportingAttachmentUrls(postBody, mirrored.mapping);
    html = rewriteSupportingAttachmentUrls(html, mirrored.mapping);
    const survivors = attachmentPlan
      .map((entry) => entry.sourceUrl)
      .filter((sourceUrl) => postBody.includes(sourceUrl) || html.includes(sourceUrl));
    if (survivors.length) {
      throw new Error(`official supporting attachment URLs survived mirror rewrite: ${survivors.join(', ')}`);
    }
  }

  const idempotencyKeyBase = buildIdempotencyKey({
    jurisdiction,
    body,
    dateIso,
    postTitle,
    postBody,
    explicit: process.env.MEETING_PUBLISH_IDEMPOTENCY_KEY || envFallback.MEETING_PUBLISH_IDEMPOTENCY_KEY || idempotencyArg,
  });

  const uploadHtmlPath = path.join(payloadDir, `${path.basename(htmlSourcePath, path.extname(htmlSourcePath))}.meeting-publish.html`);
  fs.writeFileSync(uploadHtmlPath, html, 'utf8');

  const metadataBase = {
    jurisdiction: slugify(jurisdiction),
    body: meetingRouteSlug,
    date_iso: dateIso,
    post_title: postTitle,
    post_body: postBody,
  };
  if (communityName) metadataBase.community_name = communityName;
  if (/^\d+$/u.test(communityId)) metadataBase.community_id = Number(communityId);
  if (parsedRef.post_id) metadataBase.post_id = parsedRef.post_id;
  if (parsedRef.post_url) metadataBase.post_url = parsedRef.post_url;

  const extras = parseExtras(process.env.MEETING_PUBLISH_EXTRAS_JSON || envFallback.MEETING_PUBLISH_EXTRAS_JSON || extrasArg);

  process.stdout.write(`[meeting-publish] mode: ${updateMode ? 'UPDATE' : 'CREATE'}\n`);
  process.stdout.write(`[meeting-publish] endpoint: ${endpoint}\n`);
  process.stdout.write(`[meeting-publish] transcript_html: ${uploadHtmlPath}\n`);
  if (uploadCoverPath && fs.existsSync(uploadCoverPath)) {
    process.stdout.write(`[meeting-publish] cover_image: ${uploadCoverPath}\n`);
    if (preparedCover?.originalProbe) {
      process.stdout.write(
        `[meeting-publish] cover_image_probe_original: ${preparedCover.originalProbe.width}x${preparedCover.originalProbe.height} ${preparedCover.originalProbe.bytes}B ${preparedCover.originalProbe.mime}\n`
      );
    }
    if (preparedCover?.converted && preparedCover?.probe) {
      process.stdout.write(
        `[meeting-publish] cover_image_probe_upload: ${preparedCover.probe.width}x${preparedCover.probe.height} ${preparedCover.probe.bytes}B ${preparedCover.probe.mime}\n`
      );
    }
  } else {
    process.stdout.write('[meeting-publish] cover_image: (none)\n');
  }
  process.stdout.write(`[meeting-publish] idempotency_key_base: ${idempotencyKeyBase}\n`);
  process.stdout.write(`[meeting-publish] retry policy: attempts=${maxAttempts} base_delay_ms=${baseRetryDelayMs} jitter_ms=${retryJitterMs}\n`);

  if (dryRun) {
    process.stdout.write('[meeting-publish] dry-run enabled, request not sent.\n');
    process.exit(0);
  }
  if (!token) throw new Error('MEETING_PUBLISH_AUTH_TOKEN is required unless dry-run (env/.env/secret.pya checked)');

  let disableCoverUpload = false;
  let forceCoverPath = "";

  function buildMultipartForm(metadata) {
    const form = new FormData();
    form.append('metadata', JSON.stringify(metadata));
    form.append('transcript_html', new Blob([html], { type: 'text/html; charset=utf-8' }), path.basename(uploadHtmlPath));

    const selectedCoverPath = forceCoverPath || uploadCoverPath;
    if (!disableCoverUpload && selectedCoverPath && fs.existsSync(selectedCoverPath)) {
      const imageBuf = fs.readFileSync(selectedCoverPath);
      const ext = path.extname(selectedCoverPath).toLowerCase();
      const contentType = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream');
      form.append('cover_image', new Blob([imageBuf], { type: contentType }), path.basename(selectedCoverPath));
    }

    if (extras) {
      form.append('extras_json', JSON.stringify(extras));
    }
    return form;
  }

  const responsePath = path.join(payloadDir, `${path.basename(payloadPath, path.extname(payloadPath))}.meeting-publish.response.json`);
  let parsed = null;
  let raw = '';
  let finalStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const idempotencyKey = withAttemptSuffix(idempotencyKeyBase, attempt);
    const metadata = { ...metadataBase, idempotency_key: idempotencyKey };
    process.stdout.write(`[meeting-publish] attempt ${attempt}/${maxAttempts} key=${idempotencyKey}\n`);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: buildMultipartForm(metadata),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    raw = await res.text();
    parsed = null;
    finalStatus = Number(res.status) || 0;
    try { parsed = JSON.parse(raw); } catch {}

    const responseText = `${parsed ? JSON.stringify(parsed, null, 2) : raw}\n`;
    const attemptResponsePath = path.join(
      payloadDir,
      `${path.basename(payloadPath, path.extname(payloadPath))}.meeting-publish.response.attempt-${String(attempt).padStart(2, '0')}.json`,
    );
    fs.writeFileSync(attemptResponsePath, responseText, 'utf8');
    fs.writeFileSync(responsePath, responseText, 'utf8');
    process.stdout.write(`[meeting-publish] attempt response saved: ${attemptResponsePath}\n`);
    process.stdout.write(`[meeting-publish] response saved: ${responsePath}\n`);

    if (res.ok) break;

    const rateLimited = isRateLimited(res.status, parsed);
    const lemmyLoginFailure = isLemmyLoginFailure(parsed);
    const failedIdempotencyKey = isFailedIdempotencyKey(parsed);
    const transientServerFailure = Number(res.status) >= 500;
    const pictrsUploadFailure = String(parsed?.error || '').toLowerCase().includes('failed to upload cover image to pictrs');
    if (pictrsUploadFailure && !disableCoverUpload) {
      const selectedCoverPath = forceCoverPath || uploadCoverPath;
      if (!forceCoverPath && alternateCoverPath && fs.existsSync(alternateCoverPath)) {
        forceCoverPath = alternateCoverPath;
        process.stdout.write('[meeting-publish] pictrs cover upload failed; retrying with alternate cover format\n');
        continue;
      }
      if (selectedCoverPath && fs.existsSync(selectedCoverPath)) {
        disableCoverUpload = true;
        process.stdout.write('[meeting-publish] pictrs cover upload failed; retrying without cover image\n');
        continue;
      }
    }

    const retryable = rateLimited || lemmyLoginFailure || failedIdempotencyKey || transientServerFailure;
    if (!retryable || attempt >= maxAttempts) {
      throw new Error(`meeting-publish failed (${res.status}): ${raw.slice(0, 1200)}`);
    }

    const jitterMs = retryJitterMs > 0 ? Math.floor(Math.random() * (retryJitterMs + 1)) : 0;
    let waitMs = baseRetryDelayMs + jitterMs;
    if (rateLimited) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      waitMs = Math.max(waitMs, retryAfterMs);
      process.stdout.write(`[meeting-publish] rate limited, waiting ${waitMs}ms before retry\n`);
    } else if (lemmyLoginFailure) {
      const loginBaseMs = Math.max(
        5_000,
        Number.parseInt(String(process.env.MEETING_PUBLISH_LEMMY_LOGIN_RETRY_DELAY_MS || envFallback.MEETING_PUBLISH_LEMMY_LOGIN_RETRY_DELAY_MS || '120000'), 10) || 120_000,
      );
      waitMs = loginBaseMs + jitterMs;
      process.stdout.write(`[meeting-publish] lemmy login failure, waiting ${waitMs}ms before retry\n`);
    } else if (failedIdempotencyKey) {
      waitMs = 2_000 + jitterMs;
      process.stdout.write(`[meeting-publish] stale idempotency key, waiting ${waitMs}ms before retry\n`);
    } else {
      const serverBackoff = Math.min(300_000, baseRetryDelayMs * attempt);
      waitMs = serverBackoff + jitterMs;
      process.stdout.write(`[meeting-publish] transient server error, waiting ${waitMs}ms before retry\n`);
    }
    await sleep(waitMs);
  }

  if (finalStatus < 200 || finalStatus >= 300) {
    throw new Error(`meeting-publish failed (${finalStatus}): ${raw.slice(0, 1200)}`);
  }

  if (parsed && typeof parsed === 'object') {
    if (parsed.post_url) process.stdout.write(`[meeting-publish] post_url: ${parsed.post_url}\n`);
    if (parsed.transcript_url) process.stdout.write(`[meeting-publish] transcript_url: ${parsed.transcript_url}\n`);
    if (typeof parsed.idempotent_replay === 'boolean') {
      process.stdout.write(`[meeting-publish] idempotent_replay: ${String(parsed.idempotent_replay)}\n`);
    }
  } else {
    process.stdout.write(`[meeting-publish] response: ${raw.slice(0, 600)}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
