import type { AudioStatus } from '../shared/types';

type Capturable = HTMLMediaElement & { captureStream?: () => MediaStream };

/**
 * A copy of what a player plays, made safe for the page.
 *
 * Chrome keeps every copy tied to its player for good. If the page later hands that player a live stream of its own, Chrome
 * puts a track for it into the old copy too — and on the next load it stops that track, which ends the page's own stream
 * (measured: a canvas stream given to the same player twice was ended the second time, even though the copy's tracks had
 * long been closed). So every copy made here watches for such a track for as long as the page lives, and takes it out of
 * the copy again without stopping it. With that, the page's stream stays alive (measured as well).
 */
function copyOf(element: HTMLMediaElement): MediaStream {
  const copy = (element as Capturable).captureStream!();
  copy.addEventListener('addtrack', event => { if (element.srcObject instanceof MediaStream) copy.removeTrack(event.track); });
  return copy;
}

/**
 * Listens to what a media element plays, for the Pulse Engine.
 *
 * `captureStream()` hands out a copy of the element's sound. The element itself keeps playing through the speakers exactly
 * as before: nothing is rerouted, and nothing here is ever connected to an output. Only loudness per frequency is read,
 * a few dozen times a second, and nothing is kept.
 *
 * Chrome refuses the copy for protected (EME) media and for media from another origin. Protected media is not even asked.
 * The copy ignores the player's mute and volume, so a muted player is treated as silence here.
 * Having a copy open does not get in a site's way: Chrome still lets it set media keys and play protected media in the
 * same element afterwards (checked), and the copy is closed here the moment that is noticed.
 *
 * A player that shows a live stream of the page's own (a call, a camera, a canvas) is different: there the tracks are the
 * page's, not copies. They are listened to as they are and never stopped — stopping one would end it for the page too.
 */
export class AudioTap {
  private context: AudioContext | null = null; private analyser: AnalyserNode | null = null;
  private node: MediaStreamAudioSourceNode | null = null; private stream: MediaStream | null = null; private track: MediaStreamTrack | null = null;
  // Whether the tracks are copies made for this tap (and may be closed), or the page's own (and may only be read).
  private copies = false;
  private element: HTMLMediaElement | null = null; private source = ''; private bins = new Float32Array(0);
  private readonly resume = () => { void this.context?.resume().catch(() => undefined); };
  state: AudioStatus['state'] = 'off';
  get sampleRate(): number { return this.context?.sampleRate || 48000; }
  /**
   * Listen to this element, or to nothing. Safe to call on every tick: it only acts when the element or what it plays
   * has changed, so a refusal is not asked for again and again.
   */
  attach(element: HTMLMediaElement | null, protectedMedia: boolean): void {
    const own = element?.srcObject instanceof MediaStream ? element.srcObject : null;
    const source = element ? own ? `stream:${own.id}` : element.currentSrc : '';
    if (element && (protectedMedia || element.mediaKeys)) { if (this.state !== 'protected') { this.detach(); this.state = 'protected'; } return; }
    if (element === this.element && source === this.source && this.state !== 'protected') return;
    this.detach();
    if (!element) { this.state = 'none'; return; }
    // Before the media has loaded, Chrome cannot yet tell whose it is. Wait, and look again on the next tick.
    if (element.readyState < 1) { this.state = 'none'; return; }
    this.element = element; this.source = source; this.copies = !own;
    try {
      this.stream = own || copyOf(element);
    } catch (error) {
      // SecurityError: the media comes from another origin. NotSupportedError: it is protected after all.
      this.state = (error as DOMException)?.name === 'NotSupportedError' ? 'protected' : 'blocked';
      return;
    }
    this.stream.addEventListener('addtrack', this.connect); this.connect();
  }
  /** Uses the newest live audio track. A new source in the same element (the next video on a page) adds new tracks. */
  private connect = (): void => {
    if (!this.stream) return;
    // Only the sound is wanted: the copies of the picture are closed at once so that Chrome stops producing them.
    if (this.copies) for (const video of this.stream.getVideoTracks()) video.stop();
    const track = this.stream.getAudioTracks().filter(t => t.readyState === 'live').pop() || null;
    if (track === this.track) return;
    this.node?.disconnect(); this.node = null; this.track = track;
    if (!track) { this.state = 'none'; return; }
    try {
      this.context ||= new AudioContext({ latencyHint: 'interactive' });
      if (!this.analyser) { this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0; this.bins = new Float32Array(this.analyser.frequencyBinCount); }
      this.node = this.context.createMediaStreamSource(new MediaStream([track])); this.node.connect(this.analyser);
      // A page that has not been touched yet may hold audio processing back. It starts with the first click or key.
      if (this.context.state !== 'running') for (const type of ['pointerdown', 'keydown'] as const) addEventListener(type, this.resume, { capture: true, once: true });
    } catch { this.state = 'blocked'; }
  };
  /** The spectrum right now, in decibels per bin, or null when there is nothing to hear (and `state` says why). */
  read(): Float32Array | null {
    if (!this.element || !this.stream) return null;
    // Protected after all (keys arrived after the copy was made): let go at once.
    if (this.element.mediaKeys) { this.detach(); this.state = 'protected'; return null; }
    if (!this.node || !this.analyser || !this.context) { if (this.state !== 'blocked') this.state = 'none'; return null; }
    if (this.context.state !== 'running') { this.state = 'waiting'; return null; }
    if (this.element.muted || this.element.volume === 0) { this.state = 'muted'; return null; }
    this.analyser.getFloatFrequencyData(this.bins);
    this.state = 'active';
    return this.bins;
  }
  /** Stops listening to the current element. The copies of its tracks are closed; the element is not touched. */
  detach(): void {
    this.node?.disconnect(); this.node = null; this.track = null;
    if (this.stream) { this.stream.removeEventListener('addtrack', this.connect); if (this.copies) for (const track of this.stream.getTracks()) track.stop(); }
    this.stream = null; this.element = null; this.source = ''; this.state = 'off';
  }
  /** Lets go of everything, including the audio context. */
  close(): void {
    this.detach(); this.analyser = null;
    void this.context?.close().catch(() => undefined); this.context = null;
  }
}
