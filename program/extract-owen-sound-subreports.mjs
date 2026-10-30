#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function normalizeSpaces(text) {
  return String(text || "")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "section";
}

function parseGlobalPageMarker(line) {
  const raw = normalizeSpaces(line);
  const m = raw.match(/^Page ([0-9]{1,4}) of ([0-9]{1,4})$/i);
  if (!m) return null;
  return { page: Number(m[1]), total: Number(m[2]) };
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&#58;/g, ":")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#160;/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(href) {
  const value = String(href || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://pub-owensound.escribemeetings.com/${value.replace(/^\.\//, "")}`;
}

function parseAgendaHtmlAttachments(htmlText) {
  const idToItem = new Map();
  const byItem = new Map();
  const seenAttachmentUrlByItem = new Map();
  const itemRe =
    /<DIV class='AgendaItem AgendaItem(\d+)'[\s\S]*?<DIV class='AgendaItemCounter'[^>]*>([\s\S]*?)<\/DIV>[\s\S]*?<DIV class='AgendaItemTitle'[^>]*>[\s\S]*?<a [^>]*>([\s\S]*?)<\/a>/gi;
  let m = null;
  while ((m = itemRe.exec(htmlText))) {
    const id = Number(m[1]);
    const item = normalizeSpaces(decodeHtmlEntities(m[2])).toLowerCase();
    const title = normalizeSpaces(decodeHtmlEntities(m[3]));
    if (!item || !title) continue;
    idToItem.set(id, { item, title });
  }

  const attRe =
    /<DIV class='AgendaItemAttachment AgendaItemAttachment(\d+)'[\s\S]*?<a class='Link'[^>]*href="([^"]+)"[^>]*>[\s\S]*?<SPAN class='Link'[^>]*>([\s\S]*?)<\/SPAN>/gi;
  while ((m = attRe.exec(htmlText))) {
    const id = Number(m[1]);
    const mapping = idToItem.get(id);
    if (!mapping) continue;
    const href = normalizeUrl(decodeHtmlEntities(m[2]));
    const label = normalizeSpaces(decodeHtmlEntities(m[3]));
    if (!href) continue;
    if (!byItem.has(mapping.item)) {
      byItem.set(mapping.item, { title: mapping.title, attachments: [] });
      seenAttachmentUrlByItem.set(mapping.item, new Set());
    }
    const seen = seenAttachmentUrlByItem.get(mapping.item);
    if (seen.has(href)) continue;
    seen.add(href);
    byItem.get(mapping.item).attachments.push({ label, url: href });
  }

  return byItem;
}

function isAgendaItemCode(line) {
  const raw = normalizeSpaces(line).toLowerCase();
  return /^([0-9]{1,2})\.([a-z])$/.test(raw);
}

function collectPageMarkers(lines) {
  const byPage = new Map();
  let maxTotal = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const marker = parseGlobalPageMarker(lines[i]);
    if (!marker) continue;
    if (!byPage.has(marker.page)) byPage.set(marker.page, i);
    if (marker.total > maxTotal) maxTotal = marker.total;
  }
  return { byPage, totalPages: maxTotal };
}

function findPagesHeader(lines) {
  for (let i = 0; i < Math.min(lines.length, 500); i += 1) {
    if (normalizeSpaces(lines[i]).toLowerCase() === "pages") return i;
  }
  return -1;
}

function parseTocItems(lines, startLine, endLine) {
  const items = [];
  for (let i = startLine; i <= endLine; i += 1) {
    if (!isAgendaItemCode(lines[i])) continue;
    const item = normalizeSpaces(lines[i]).toLowerCase();
    const titleParts = [];
    let page = null;
    let j = i + 1;
    for (; j <= endLine; j += 1) {
      const raw = normalizeSpaces(lines[j]);
      if (!raw) continue;
      if (isAgendaItemCode(raw)) break;
      if (/^[0-9]{1,4}\.?$/.test(raw)) {
        page = Number(raw.replace(/\./g, ""));
        continue;
      }
      if (/^[0-9]{1,2}\.$/.test(raw)) break;
      titleParts.push(raw);
    }
    items.push({
      item,
      title: titleParts.join(" ").trim() || item,
      start_page: page !== null && page > 0 ? page : null,
    });
    i = j - 1;
  }
  return items;
}

function dedupeAndSortItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.item}:${item.start_page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  out.sort((a, b) => {
    const ap = Number.isFinite(a.start_page) ? a.start_page : Number.POSITIVE_INFINITY;
    const bp = Number.isFinite(b.start_page) ? b.start_page : Number.POSITIVE_INFINITY;
    return ap - bp || a.item.localeCompare(b.item);
  });
  return out;
}

function main() {
  const [, , inputPath, outputDir, outputIndexPath, agendaHtmlPath] = process.argv;
  if (!inputPath || !outputDir) {
    process.stderr.write(
      "usage: node extract-owen-sound-subreports.mjs <agenda.md> <output_dir> [output_index.json]\n",
    );
    process.exit(2);
  }

  const text = fs.readFileSync(inputPath, "utf8");
  const lines = text.split(/\r?\n/);
  const { byPage, totalPages } = collectPageMarkers(lines);
  const pagesHeader = findPagesHeader(lines);
  const tocEnd = (() => {
    for (let i = Math.max(0, pagesHeader); i < lines.length; i += 1) {
      const m = parseGlobalPageMarker(lines[i]);
      if (m && m.page >= 2) return i;
    }
    return -1;
  })();

  const tocItemsRaw =
    pagesHeader >= 0 && tocEnd > pagesHeader
      ? parseTocItems(lines, pagesHeader + 1, tocEnd - 1)
      : [];
  const tocItems = dedupeAndSortItems(tocItemsRaw).filter(
    (x) => Number.isFinite(x.start_page) && byPage.has(x.start_page),
  );

  const sections = [];
  for (let i = 0; i < tocItems.length; i += 1) {
    const current = tocItems[i];
    const next = tocItems[i + 1];
    const startPage = current.start_page;
    const nextStartPage = next ? next.start_page : totalPages + 1;
    const endPage = Math.max(startPage, nextStartPage - 1);
    const startLine = byPage.get(startPage);
    const nextStartLine = byPage.get(nextStartPage);
    if (typeof startLine !== "number") continue;
    const endLine =
      typeof nextStartLine === "number" ? Math.max(startLine, nextStartLine - 1) : lines.length - 1;
    const sectionText = `${lines.slice(startLine, endLine + 1).join("\n").trim()}\n`;
    const fileName = `${current.item.replace(".", "-")}_${slugify(current.title)}.md`;
    const filePath = path.join(outputDir, fileName);
    sections.push({
      item: current.item,
      title: current.title,
      start_page: startPage,
      end_page: endPage,
      line_start: startLine + 1,
      line_end: endLine + 1,
      file: filePath,
      text: sectionText,
    });
  }

  fs.mkdirSync(outputDir, { recursive: true });
  for (const section of sections) {
    fs.writeFileSync(section.file, section.text, "utf8");
  }

  const attachmentsByItem = (() => {
    if (!agendaHtmlPath) return new Map();
    if (!fs.existsSync(agendaHtmlPath)) return new Map();
    const html = fs.readFileSync(agendaHtmlPath, "utf8");
    return parseAgendaHtmlAttachments(html);
  })();

  const indexPath = outputIndexPath || path.join(outputDir, "subreports.index.json");
  const index = {
    source_file: inputPath,
    output_dir: outputDir,
    generated_at_utc: new Date().toISOString(),
    total_pages_detected: totalPages,
    toc_window: {
      start_line: pagesHeader >= 0 ? pagesHeader + 1 : null,
      end_line: tocEnd >= 0 ? tocEnd + 1 : null,
    },
    section_count: sections.length,
    sections: sections.map((s) => ({
      item: s.item,
      title: s.title,
      start_page: s.start_page,
      end_page: s.end_page,
      line_start: s.line_start,
      line_end: s.line_end,
      file: s.file,
    })),
    items_without_pages_from_toc: tocItemsRaw
      .filter((x) => !Number.isFinite(x.start_page))
      .map((x) => ({ item: x.item, title: x.title })),
    attachments_from_html: Array.from(attachmentsByItem.entries()).map(
      ([item, data]) => ({
        item,
        title: data.title,
        attachment_count: data.attachments.length,
        attachments: data.attachments,
      }),
    ),
  };

  const sectionByItem = new Map(index.sections.map((x) => [x.item, x]));
  index.items = Array.from(
    new Set([
      ...index.sections.map((x) => x.item),
      ...Array.from(attachmentsByItem.keys()),
    ]),
  )
    .sort()
    .map((item) => {
      const fromSection = sectionByItem.get(item);
      const fromHtml = attachmentsByItem.get(item);
      return {
        item,
        title: fromSection?.title || fromHtml?.title || item,
        has_page_slice: Boolean(fromSection),
        start_page: fromSection?.start_page ?? null,
        end_page: fromSection?.end_page ?? null,
        file: fromSection?.file ?? null,
        attachments: fromHtml?.attachments ?? [],
      };
    });

  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  process.stdout.write(
    `extracted ${sections.length} page-sliced subreports and ${index.attachments_from_html.length} attachment groups from ${path.basename(inputPath)} -> ${outputDir}\n`,
  );
}

main();
