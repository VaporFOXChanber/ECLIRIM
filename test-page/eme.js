// A rights-safe EME fixture generated from FFmpeg testsrc2. These public test keys
// belong ONLY to encrypted-fixture.mp4. Decryption is handled by standard browser EME.
// No third-party keys, licenses, DRM interception, or protection bypass is involved.
document.querySelector('#eme-test').onclick = async () => {
  const info = document.querySelector('#info');
  try {
    const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{
      initDataTypes: ['keyids', 'cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42C01F"' }]
    }]);
    const keys = await access.createMediaKeys();
    // Use a fresh element: a MediaStream-backed element must not retain the old source.
    const old = document.querySelector('#player video'), v = document.createElement('video');
    v.controls = true; v.muted = true; v.playsInline = true; v.loop = true; old.pause(); old.replaceWith(v);
    await v.setMediaKeys(keys);
    const session = keys.createSession();
    const b64 = hex => btoa(String.fromCharCode(...hex.match(/../g).map(v => parseInt(v, 16)))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const kid = b64('11223344556677889900aabbccddeeff'), k = b64('00112233445566778899aabbccddeeff');
    session.addEventListener('message', async () => {
      await session.update(new TextEncoder().encode(JSON.stringify({ keys: [{ kty: 'oct', kid, k }], type: 'temporary' })));
    });
    await session.generateRequest('keyids', new TextEncoder().encode(JSON.stringify({ kids: [kid] })));
    const source = new MediaSource(); v.src = URL.createObjectURL(source);
    await new Promise(resolve => source.addEventListener('sourceopen', resolve, { once: true }));
    const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.42C01F"');
    const data = await (await fetch('encrypted-fixture.mp4')).arrayBuffer();
    const appended = new Promise((resolve, reject) => {
      buffer.addEventListener('updateend', resolve, { once: true });
      buffer.addEventListener('error', () => reject(new Error('MSE append failed')), { once: true });
    });
    buffer.appendBuffer(data); await appended; source.endOfStream(); await v.play();
    info.textContent = '自作の暗号化素材を標準EME / ClearKeyで再生中。Widevineや商用配信の検証とは異なります。通常テストへ戻るにはページを再読み込みしてください。';
    window.__emeSession = session;
  } catch (e) { info.textContent = 'EMEテストを開始できませんでした: ' + e; }
};
