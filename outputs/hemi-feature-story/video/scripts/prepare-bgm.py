#!/usr/bin/env python3
"""Prepare the licensed BGM without changing any video frames."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
AUDIO = ROOT / 'public/audio/bgm'
SOURCE = AUDIO / 'fs-788347.mp3'
OUTPUT = AUDIO / 'gentle-piano-guitar.wav'
DURATION = 65
TARGET = 'loudnorm=I=-24:TP=-3:LRA=9'

def run(args):
    return subprocess.run(args, text=True, capture_output=True, check=True)

measurement = run(['ffmpeg', '-hide_banner', '-i', str(SOURCE), '-t', str(DURATION),
                   '-af', TARGET + ':print_format=json', '-f', 'null', '-'])
blocks = re.findall(r'\{\s*"input_i"[\s\S]*?\}', measurement.stderr)
if not blocks:
    raise RuntimeError('loudnorm measurement not returned')
stats = json.loads(blocks[-1])
if stats['input_i'] in ('-inf', 'inf'):
    raise RuntimeError('source is silent or invalid')
normalizer = TARGET + ''.join([
    ':measured_I=' + stats['input_i'],
    ':measured_TP=' + stats['input_tp'],
    ':measured_LRA=' + stats['input_lra'],
    ':measured_thresh=' + stats['input_thresh'],
    ':offset=' + stats['target_offset'],
    ':linear=true:print_format=json',
])
processed = run(['ffmpeg', '-hide_banner', '-y', '-i', str(SOURCE), '-t', str(DURATION),
                 '-af', normalizer, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', str(OUTPUT)])
info = json.loads(run(['ffprobe', '-v', 'error', '-show_entries',
                      'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', str(OUTPUT)]).stdout)
record = {
    'source': {'id': 'fs:788347', 'title': 'Calm Background Music', 'author': 'MrCatfishing',
               'page': 'https://freesound.org/people/MrCatfishing/sounds/788347/',
               'license': 'CC0-1.0', 'file': SOURCE.name,
               'sha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
               'kind': 'Freesound HQ MP3 preview; not an original lossless recording'},
    'prepared_file': OUTPUT.name,
    'prepared_sha256': hashlib.sha256(OUTPUT.read_bytes()).hexdigest(),
    'changes': ['Trim source to 0–65 seconds', 'Two-pass linear loudness normalization to -24 LUFS, TP ceiling -3 dBTP',
                'Decode to 48 kHz stereo PCM for rendering; this does not recover source lossless quality'],
    'loudnorm_first_pass': stats,
    'normalizer': normalizer,
    'prepared_media': info,
    'timeline_fades': {'fade_in_seconds': 1.5, 'fade_out_seconds': 4.0,
                       'implemented_in': 'src/Main.tsx BGM volume function'},
    'audition': 'Metadata and objective measurements checked; not listened to by this assistant',
}
(AUDIO / 'BGM-processing.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'prepared_file': str(OUTPUT), 'source_measurement': stats,
                  'duration': info['format']['duration'], 'sha256': record['prepared_sha256']}, ensure_ascii=False, indent=2))
