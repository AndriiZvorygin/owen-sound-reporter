import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SUMMARY_FOCUS } from './defaults.mjs';
import { defineWriterAdapter } from '../../../../program/library/reporter_shared/writer-adapter-interface.mjs';

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOUSE_ROOT = path.resolve(PROGRAM_DIR, '..');

export const OWEN_ADAPTER = defineWriterAdapter({
  writer_id: 'owen-sound-reporter',
  source_id: 'escribe',
  house_root: HOUSE_ROOT,
  artifacts_slug: 'owen-sound',
  refresh_calendar_cmd: ['node', path.join(PROGRAM_DIR, 'extract-owen-sound-calendar-monthly.mjs')],
  run_meeting_from_ref_cmd: ['node', path.join(PROGRAM_DIR, 'run-owen-sound-meeting-from-ref.mjs')],
  send_dm_cmd: ['node', path.join(PROGRAM_DIR, 'send-executive-dm.mjs')],
  identity: {
    jurisdiction: 'Owen Sound',
    default_body: 'auto',
    community_name: 'owen-sound-council',
  },
  publish: {
    community_name: 'owen-sound-council',
    command_env_order: ['OWEN_LEMMY_POST_COMMAND', 'MEETING_POST_COMMAND'],
  },
  defaults: {
    base_prefix: 'meeting-qwen-auto',
    focus: DEFAULT_SUMMARY_FOCUS,
    jurisdiction: 'Owen Sound',
    body: 'auto',
    site_url: 'https://helpos.ca',
    discussion_url: '',
    exec_mxid: '@operator:example.invalid',
    community_name: 'owen-sound-council',
    timezone: 'America/Toronto',
    transcript_jurisdiction_slug: 'owen-sound',
  },
});
