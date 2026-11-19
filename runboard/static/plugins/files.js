/* Example plugin: a "파일" tab that shows images, videos and text files saved in the focused run's folder.
 *
 * A plugin is one script in static/plugins/<name>.js, enabled by listing <name> under "plugins" in runboard.json.
 * It calls Runboard.registerTab({ id, title, render(el, ctx) }):
 *   el   the tab's container element (fill it with HTML)
 *   ctx  { run, selected, api, esc }: the focused run, the runs checked for comparison, the HTTP helpers
 * Copy this file to start your own tab (e.g. sample predictions, confusion matrices, rollouts).
 */
(function () {
  const IMG = /\.(png|jpe?g|gif|webp|svg)$/i, VID = /\.(mp4|webm)$/i, TXT = /\.(json|txt|csv|log|md)$/i;
  const kb = (n) => (n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

  Runboard.registerTab({
    id: "files",
    title: "파일",
    async render(el, { run, api, esc }) {
      if (!run) { el.innerHTML = '<div class="empty-state">실행을 고르세요</div>'; return; }
      const { files } = await api.files(run.name);
      if (!files.length) {
        el.innerHTML = `<div class="controls"></div><div class="empty-state">이 실행 폴더에 이미지·영상·텍스트 파일이 없습니다.<br>
          학습 코드에서 <code>log.save_file("samples/step100.png", png_bytes)</code>처럼 저장하면 여기에 나타납니다.</div>`;
        return;
      }
      const url = (f) => api.fileUrl(run.name, f.path);
      const imgs = files.filter((f) => IMG.test(f.path)), vids = files.filter((f) => VID.test(f.path)), txts = files.filter((f) => TXT.test(f.path));
      const fig = (f, inner) => `<figure style="margin:0;display:flex;flex-direction:column;gap:4px">${inner}<figcaption class="hint mono">${esc(f.path)} · ${kb(f.size)}</figcaption></figure>`;
      el.innerHTML = `<div class="controls"><span class="hint">${esc(run.name)} 폴더의 파일 ${files.length}개 (최근 수정 순이 아니라 경로 순)</span></div>
        ${imgs.length ? `<h4 class="group-h">이미지 ${imgs.length}</h4><div class="charts">${imgs.slice(0, 60).map((f) => fig(f, `<a href="${url(f)}" target="_blank" rel="noopener"><img src="${url(f)}" alt="${esc(f.path)}" loading="lazy" style="width:100%;border:1px solid var(--line);border-radius:6px;background:var(--surface-2)"></a>`)).join("")}</div>` : ""}
        ${vids.length ? `<h4 class="group-h">영상 ${vids.length}</h4><div class="charts">${vids.slice(0, 20).map((f) => fig(f, `<video src="${url(f)}" controls preload="metadata" style="width:100%;border-radius:6px"></video>`)).join("")}</div>` : ""}
        ${txts.length ? `<h4 class="group-h">텍스트 ${txts.length}</h4><div class="table-wrap"><table><tbody>${txts.map((f) => `<tr><td class="mono"><a href="${url(f)}" target="_blank" rel="noopener">${esc(f.path)}</a></td><td class="n">${kb(f.size)}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
    },
  });
})();
