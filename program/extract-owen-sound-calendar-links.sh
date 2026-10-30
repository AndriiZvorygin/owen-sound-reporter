#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="/home/htaf/pyac/pyash/world/house/owen-sound-reporter/artifacts/owen-sound"
OUT_JSON="${OUT_DIR}/calendar-links.json"
OUT_TXT="${OUT_DIR}/calendar-links.txt"

mkdir -p "${OUT_DIR}"

curl -sS 'https://pub-owensound.escribemeetings.com/MeetingsCalendarView.aspx/GetCalendarMeetings' \
  -H 'Content-Type: application/json; charset=UTF-8' \
  --data-raw '{"calendarStartDate":"2020-01-01","calendarEndDate":"2030-12-31"}' \
| jq --arg base 'https://pub-owensound.escribemeetings.com/' '
{
  source: "https://pub-owensound.escribemeetings.com/MeetingsCalendarView.aspx/GetCalendarMeetings",
  calendar_start: "2020-01-01",
  calendar_end: "2030-12-31",
  fetched_at_utc: (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
  meeting_count: (.d | length),
  meetings: [
    .d[] | {
      id: .ID,
      meeting_name: .MeetingName,
      meeting_type: .MeetingType,
      formatted_start: .FormattedStart,
      start_date: .StartDate,
      end_date: .EndDate,
      location: .Location,
      meeting_url: (
        if ((.Url // "") == "") then ($base + "MeetingsCalendarView.aspx/Meeting?Id=" + .ID)
        elif (.Url | startswith("http")) then .Url
        elif (.Url | startswith("./")) then ($base + (.Url | ltrimstr("./")))
        else ($base + .Url)
        end
      ),
      documents: [
        (.MeetingDocumentLink // [])[] | {
          title: (.Title // ""),
          type: (.Type // ""),
          format: (.Format // ""),
          url: (
            if ((.Url // "") == "") then empty
            elif (.Url | startswith("http")) then .Url
            elif (.Url | startswith("./")) then ($base + (.Url | ltrimstr("./")))
            else ($base + .Url)
            end
          )
        }
      ]
    }
  ],
  unique_links: (
    [
      (.d[] |
        if ((.Url // "") == "") then ($base + "MeetingsCalendarView.aspx/Meeting?Id=" + .ID)
        elif (.Url | startswith("http")) then .Url
        elif (.Url | startswith("./")) then ($base + (.Url | ltrimstr("./")))
        else ($base + .Url)
        end
      ),
      (.d[] | (.MeetingDocumentLink // [])[]?.Url |
        if . == null or . == "" then empty
        elif startswith("http") then .
        elif startswith("./") then ($base + (ltrimstr("./")))
        else ($base + .)
        end
      )
    ] | flatten | unique
  )
}
' > "${OUT_JSON}"

jq -r '.unique_links[]' "${OUT_JSON}" > "${OUT_TXT}"

printf 'wrote %s meetings and %s unique links\n' \
  "$(jq -r '.meeting_count' "${OUT_JSON}")" \
  "$(wc -l < "${OUT_TXT}")"
