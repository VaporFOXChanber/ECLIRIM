#!/bin/sh
set -eu
# Synthetic public test signals only; FFmpeg is a development-time requirement.
ffmpeg -hide_banner -loglevel error -f lavfi -i 'testsrc2=size=960x540:rate=24:duration=12' \
  -c:v libvpx -b:v 600k -an -y test-page/fixture.webm
# The local EME demo consumes this via MSE, using the public test key below.
ffmpeg -hide_banner -loglevel error -f lavfi -i 'testsrc2=size=960x540:rate=24:duration=12' \
  -c:v libx264 -profile:v baseline -pix_fmt yuv420p -b:v 700k -g 24 -an \
  -movflags +frag_keyframe+empty_moov+default_base_moof \
  -encryption_scheme cenc-aes-ctr -encryption_key 00112233445566778899aabbccddeeff \
  -encryption_kid 11223344556677889900aabbccddeeff -y test-page/encrypted-fixture.mp4

# 0.9.0 — Pulse Engine: one still picture with a sound track in sections, so a test can seek to the sound it needs.
# The sections are separated by silence: a seek decodes a little audio from before its target, and that must not be
# the sound of another section.
#   0–6 s    a 120 BPM kick         7–11 s   one steady tone          12–16 s  hi-hat ticks (7 kHz) at 4 Hz
#   16–21 s  silence                21–26 s  quiet bed, a blast at 23.5 s
#   27–33 s  kicks at 8 Hz (faster than the Flash Limiter lets beats through)
#   34–42 s  a small loop of kick, bass, hats and a melody, for Music Mode
ffmpeg -hide_banner -loglevel error -f lavfi -i 'color=c=0x286ea0:s=320x180:r=24:d=42' -f lavfi -i "aevalsrc='\
between(t,0,6)*0.8*sin(2*PI*60*t)*exp(-12*mod(t,0.5))\
+between(t,7,11)*0.3*sin(2*PI*220*t)\
+between(t,12,16)*0.3*sin(2*PI*7000*t)*exp(-60*mod(t,0.25))\
+between(t,21,26)*0.03*sin(2*PI*300*t)\
+between(t,23.5,26)*(0.7*sin(2*PI*50*t)+0.5*sin(2*PI*400*t)+0.2*(random(1)*2-1))*exp(-4*(t-23.5))\
+between(t,27,33)*0.8*sin(2*PI*60*t)*exp(-30*mod(t,0.125))\
+between(t,34,42)*(0.7*sin(2*PI*60*t)*exp(-12*mod(t,0.5))+0.25*sin(2*PI*80*t)*exp(-3*mod(t,1))\
+0.2*sin(2*PI*7000*t)*exp(-60*mod(t+0.25,0.5))+0.15*sin(2*PI*(440+110*floor(mod(t*4,3)))*t)*exp(-8*mod(t,0.25)))\
':s=48000:d=42" -c:v libvpx -b:v 40k -g 48 -c:a libopus -b:a 64k -y test-page/pulse.webm
# 0.9.0 — Color Engine 2.0: tiny clips that only differ in how their colours are tagged (AV1 carries the tags in the stream).
ffmpeg -hide_banner -loglevel error -f lavfi -i 'testsrc2=size=320x180:rate=24:duration=3' -c:v libsvtav1 -preset 10 -pix_fmt yuv420p -b:v 150k -g 24 -an -y /tmp/eclirim-8bit.mp4
ffmpeg -hide_banner -loglevel error -f lavfi -i 'testsrc2=size=320x180:rate=24:duration=3' -c:v libsvtav1 -preset 10 -pix_fmt yuv420p10le -b:v 150k -g 24 -an -y /tmp/eclirim-10bit.mp4
ffmpeg -hide_banner -loglevel error -i /tmp/eclirim-8bit.mp4 -c copy -bsf:v 'av1_metadata=color_primaries=12:transfer_characteristics=1:matrix_coefficients=1' -y test-page/color-p3.mp4
ffmpeg -hide_banner -loglevel error -i /tmp/eclirim-10bit.mp4 -c copy -bsf:v 'av1_metadata=color_primaries=9:transfer_characteristics=16:matrix_coefficients=9' -y test-page/color-hdr.mp4
rm -f /tmp/eclirim-8bit.mp4 /tmp/eclirim-10bit.mp4
