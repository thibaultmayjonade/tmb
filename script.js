
(() => {
  const DATA = window.TMB_DATA;
  const { stages, routeCoords, stagePoints, budget, checklist } = DATA;
  const COLORS = {confirmed:'#254c3a', bivouac:'#b8912e', missing:'#b95732', end:'#437c90'};
  const fmt = n => Math.round(n).toLocaleString('fr-FR');
  const eur = n => n == null ? 'à confirmer' : `${Number(n).toLocaleString('fr-FR')} €`;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  let selectedStage = initialStageIndex();
  let progress = 0;
  let playing = false;
  let playAllMode = false;
  let lastTs = null;
  let map, layers = {};
  let activeTileLayer = null;
  let activeTileSource = 0;
  const TILE_SOURCES = [
    {
      name:'Carto Voyager',
      url:'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      options:{subdomains:'abcd', maxZoom:19, detectRetina:true, attribution:'&copy; OpenStreetMap contributors &copy; CARTO'}
    },
    {
      name:'OpenStreetMap',
      url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      options:{maxZoom:19, detectRetina:true, attribution:'&copy; OpenStreetMap contributors'}
    }
  ];
  const BASE_DURATION = 15000;

  function $(sel, root=document){ return root.querySelector(sel); }
  function $all(sel, root=document){ return [...root.querySelectorAll(sel)]; }
  function colorFor(stage){ return COLORS[stage.status] || COLORS.confirmed; }
  function statusClass(stage){ return stage.status === 'end' ? 'end' : stage.status; }
  function toast(msg){ const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.remove('show'),2200); }
  function initialStageIndex(){
    const now = new Date();
    const idx = stages.findIndex(s => s.dateISO === now.toISOString().slice(0,10));
    return idx >= 0 ? idx : 0;
  }
  function cumulativeKm(stage, ratio){ return stage.km * ratio; }
  function currentAlt(stage, ratio){ const p=stage.profile; if(!p.length) return null; const x=ratio*(p.length-1); const i=Math.floor(x); const f=x-i; return Math.round((p[i]||p[0])*(1-f)+(p[i+1]||p[p.length-1])*f); }

  function setCanvas(canvas, h=220){
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(300, canvas.clientWidth || canvas.offsetWidth || canvas.parentElement?.clientWidth || 400);
    canvas.width = Math.floor(w*dpr); canvas.height = Math.floor(h*dpr);
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
    return {ctx,w,h};
  }
  function bounds(coords){
    const lats=coords.map(c=>c[0]), lons=coords.map(c=>c[1]);
    return {minLat:Math.min(...lats),maxLat:Math.max(...lats),minLon:Math.min(...lons),maxLon:Math.max(...lons)};
  }
  function project(coords,w,h,pad=24){
    const b=bounds(coords); const latR=b.maxLat-b.minLat || 1; const lonR=b.maxLon-b.minLon || 1;
    const sx=(w-pad*2)/lonR; const sy=(h-pad*2)/latR; const scale=Math.min(sx,sy);
    const usedW=lonR*scale, usedH=latR*scale; const ox=(w-usedW)/2, oy=(h-usedH)/2;
    return coords.map(([lat,lon])=>[ox+(lon-b.minLon)*scale, oy+(b.maxLat-lat)*scale]);
  }
  function drawPath(ctx, pts, color, width=3, alpha=1, upto=1){
    if(pts.length < 2) return;
    const max = Math.max(1, Math.floor((pts.length-1)*upto));
    ctx.save(); ctx.globalAlpha=alpha; ctx.strokeStyle=color; ctx.lineWidth=width; ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for(let i=1;i<=max;i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke(); ctx.restore();
  }
  function drawRouteCanvas(){
    const canvas = $('#routeCanvas'); const {ctx,w,h}=setCanvas(canvas, canvas.clientWidth < 520 ? 290 : 430);
    const stage=stages[selectedStage], color=colorFor(stage);
    ctx.clearRect(0,0,w,h);
    const bg=ctx.createLinearGradient(0,0,w,h); bg.addColorStop(0,'#111916'); bg.addColorStop(1,'#254b55'); ctx.fillStyle=bg; ctx.fillRect(0,0,w,h);
    // light contour lines
    ctx.globalAlpha=.18; ctx.strokeStyle='#fff'; ctx.lineWidth=1;
    for(let i=0;i<7;i++){ ctx.beginPath(); const y=(h/8)*(i+1); ctx.moveTo(18,y); for(let x=18;x<w-18;x+=24){ ctx.lineTo(x,y+Math.sin((x+i*17)/45)*4); } ctx.stroke(); }
    ctx.globalAlpha=1;
    const allPts=project(routeCoords,w,h,28); drawPath(ctx,allPts,'rgba(255,255,255,.28)',2,1,1);
    const pts=project(stage.coords,w,h,28); drawPath(ctx,pts,color,5,.38,1); drawPath(ctx,pts,'#fff',2,.85,progress);
    const idx = Math.min(pts.length-1, Math.floor(progress*(pts.length-1))); const dot=pts[idx] || pts[0];
    if(dot){ ctx.beginPath(); ctx.arc(dot[0],dot[1],8,0,Math.PI*2); ctx.fillStyle='#fff'; ctx.fill(); ctx.beginPath(); ctx.arc(dot[0],dot[1],4,0,Math.PI*2); ctx.fillStyle=color; ctx.fill(); }
    ctx.fillStyle='rgba(255,255,255,.92)'; ctx.font='900 16px system-ui';
    const titleText = `${stage.key} · ${stage.from} → ${stage.to}`;
    const maxW = w - 44;
    let truncated = titleText;
    while(ctx.measureText(truncated).width > maxW && truncated.length > 8) truncated = truncated.slice(0,-1);
    if(truncated !== titleText) truncated = truncated.slice(0,-1) + '…';
    ctx.fillText(truncated, 22, 32);
    ctx.font='800 12px system-ui'; ctx.fillStyle='rgba(255,255,255,.70)'; ctx.fillText(`${stage.km} km · +${fmt(stage.dp)} m · -${fmt(stage.dm)} m · ${stage.duration}`,22,52);
  }
  function drawProfile(canvas, stage, ratio=1){
    const {ctx,w,h}=setCanvas(canvas, Number(canvas.dataset.h) || (canvas.classList.contains('mini-profile') ? 90 : 145));
    const p=stage.profile, min=Math.min(...p), max=Math.max(...p), range=max-min || 1, pad={t:12,r:10,b:18,l:10};
    const color=colorFor(stage); ctx.clearRect(0,0,w,h); ctx.fillStyle='#fffdf8'; ctx.fillRect(0,0,w,h);
    ctx.strokeStyle='rgba(31,36,33,.08)'; ctx.lineWidth=1; for(let i=1;i<4;i++){ const y=pad.t+(h-pad.t-pad.b)*i/4; ctx.beginPath(); ctx.moveTo(pad.l,y); ctx.lineTo(w-pad.r,y); ctx.stroke(); }
    const x=i => pad.l + (i/(p.length-1))*(w-pad.l-pad.r); const y=v => h-pad.b-((v-min)/range)*(h-pad.t-pad.b);
    const limit = Math.max(1, Math.floor((p.length-1)*ratio));
    const grad=ctx.createLinearGradient(0,0,0,h); grad.addColorStop(0,color+'50'); grad.addColorStop(1,color+'08');
    ctx.beginPath(); ctx.moveTo(pad.l,h-pad.b); for(let i=0;i<=limit;i++) ctx.lineTo(x(i),y(p[i])); ctx.lineTo(x(limit),h-pad.b); ctx.closePath(); ctx.fillStyle=grad; ctx.fill();
    ctx.beginPath(); ctx.moveTo(x(0),y(p[0])); for(let i=1;i<=limit;i++) ctx.lineTo(x(i),y(p[i])); ctx.strokeStyle=color; ctx.lineWidth=2.5; ctx.lineJoin='round'; ctx.stroke();
    const curAlt=currentAlt(stage,ratio); ctx.fillStyle='rgba(31,36,33,.72)'; ctx.font='800 11px system-ui'; ctx.fillText(`${stage.alt_start} m`,pad.l,h-5); ctx.textAlign='center'; ctx.fillText(`max ${stage.alt_max} m`,w/2,h-5); ctx.textAlign='right'; ctx.fillText(`${stage.alt_end} m`,w-pad.r,h-5); ctx.textAlign='left';
    if(ratio < 1 && curAlt){ const xi=x(limit); const yi=y(curAlt); ctx.beginPath(); ctx.arc(xi,yi,5,0,Math.PI*2); ctx.fillStyle=color; ctx.fill(); }
  }
  function updateVideoInfo(){
    const s=stages[selectedStage], alt=currentAlt(s,progress); const km=cumulativeKm(s,progress);
    $('#videoStageInfo').innerHTML = `<span class="badge ${statusClass(s)}">${esc(s.badge)}</span><h3>${esc(s.key)} · ${esc(s.from)} → ${esc(s.to)}</h3><p class="muted">${esc(s.date)} · ${esc(s.country)}</p><div class="stage-stats"><div class="info-tile"><div class="label">Progression</div><div class="value">${Math.round(progress*100)} %</div></div><div class="info-tile"><div class="label">Distance</div><div class="value">${km.toFixed(1)} km</div></div><div class="info-tile"><div class="label">Altitude</div><div class="value">${alt||'—'} m</div></div><div class="info-tile"><div class="label">Nuit</div><div class="value">${esc(s.statusLabel)}</div></div></div><p class="small"><b>Hébergement :</b> ${esc(s.lodging)}</p>`;
    $('#progressBar').style.width = `${Math.round(progress*100)}%`;
    $all('.stage-dot').forEach((btn,i)=>btn.classList.toggle('is-active',i===selectedStage));
  }
  function drawVideo(){ drawRouteCanvas(); drawProfile($('#profileCanvas'), stages[selectedStage], progress); updateVideoInfo(); }
  function animate(ts){
    if(!playing){ lastTs=null; return; }
    if(lastTs == null) lastTs = ts;
    const speed = Number($('#speedSelect').value || 1);
    progress += (ts-lastTs) / (BASE_DURATION / speed);
    lastTs = ts;
    if(progress >= 1){
      progress = 1; drawVideo();
      if(playAllMode && selectedStage < stages.length-1){ selectedStage++; progress=0; lastTs=null; updateAllSelected(); requestAnimationFrame(animate); return; }
      playing=false; playAllMode=false; $('#playSelected').textContent='▶ Revoir'; $('#playAll').textContent='Lire les 9 étapes'; return;
    }
    drawVideo(); requestAnimationFrame(animate);
  }
  function startVideo(all=false){ playing=true; playAllMode=all; if(progress>=1) progress=0; $('#playSelected').textContent='⏸ Lecture'; $('#playAll').textContent=all?'⏸ Lecture complète':'Lire les 9 étapes'; requestAnimationFrame(animate); }
  function selectStage(i){ selectedStage=Math.max(0,Math.min(stages.length-1,i)); progress=0; playing=false; playAllMode=false; lastTs=null; updateAllSelected(); drawVideo(); }
  function updateAllSelected(){
    $('#stageSelect').value=String(selectedStage);
    $all('[data-stage-button]').forEach(btn=>btn.classList.toggle('is-active',Number(btn.dataset.stageButton)===selectedStage));
    $all('.stage-dot').forEach((btn,i)=>btn.classList.toggle('is-active',i===selectedStage));
    const lbl = $('#trekStageLabel');
    if(lbl){ const s=stages[selectedStage]; lbl.textContent = `${s.key} · ${s.from} → ${s.to}`; }
    renderTrekCard(); if(map) highlightMapStage(selectedStage,false);
  }

  function renderHero(){
    const t=DATA.meta.totals;
    $('#heroStats').innerHTML = `<div class="hero-stat"><b>${t.days}</b><span>jours</span></div><div class="hero-stat"><b>${String(t.km).replace('.',',')} km</b><span>distance</span></div><div class="hero-stat"><b>+${fmt(t.dp)} m</b><span>dénivelé +</span></div><div class="hero-stat"><b>${eur(t.knownBudget)}</b><span>budget connu</span></div>`;
  }
  function renderDashboard(){
    const t=DATA.meta.totals;
    const missing=stages.filter(s=>s.status==='missing').length;
    $('#dashboardCards').innerHTML = [
      ['🗓️',t.days,'jours de marche'], ['🥾',String(t.km).replace('.',','),'km marche estimés'], ['⛰️','+'+fmt(t.dp)+' m','D+ cumulé'], ['⚠️',missing,'point hébergement à régler']
    ].map((c,i)=>`<article class="metric-card ${i===3&&missing?'warning':''}"><div class="icon">${c[0]}</div><div class="value">${c[1]}</div><div class="label">${c[2]}</div></article>`).join('');
    const miss=stages.find(s=>s.status==='missing');
    $('#priorityCard').innerHTML = `<div class="priority-eyebrow">⚠️ ACTION REQUISE</div><h3>Priorité actuelle</h3><p><b>${miss.key} · ${esc(miss.from)} → ${esc(miss.to)}</b></p><p>${esc(miss.lodging)}.</p><p class="muted small">${esc(miss.priorityText || 'À verrouiller : hébergement, horaires de navette et marge horaire.')}</p><button class="btn btn-primary" data-stage-detail="${stages.indexOf(miss)}">Ouvrir la fiche ${esc(miss.key)}</button>`;
  }
  function renderStagePicker(){
    $('#stagePicker').innerHTML = stages.map((s,i)=>`<button class="stage-dot ${i===selectedStage?'is-active':''}" data-stage-button="${i}">${s.key}</button>`).join('');
    $('#stageSelect').innerHTML = stages.map((s,i)=>`<option value="${i}">${s.key} · ${esc(s.from)} → ${esc(s.to)}</option>`).join('');
    $('#stageSelect').value=String(selectedStage);
  }
  function renderPrep(){
    const priorities = [
      ['J4 Courmayeur', 'Réserver une nuit à Courmayeur du 23 au 24 juillet, idéalement près de Piazzale Monte Bianco ou d’un arrêt de navette.', 'missing'],
      ['Navette Val Ferret', 'Confirmer en juin/juillet 2026 les horaires Courmayeur ↔ Bivio Rifugio Bonatti.', 'missing'],
      ['Bivouacs', 'Valider matériel, règles locales, eau et repas pour J2, J6 et J7.', 'bivouac'],
      ['Budget', 'Ajouter le coût réel de la nuit Courmayeur dès confirmation pour avoir le coût complet par personne.', 'confirmed'],
      ['Trace hors ligne', 'Ouvrir la page et l’application GPS avant le départ pour mettre les données en cache.', 'confirmed']
    ];
    $('#prepPriorities').innerHTML = priorities.map(([title,txt,cl])=>`<div class="timeline-item ${cl}"><div class="timeline-key">${cl==='missing'?'!':cl==='bivouac'?'⛺':'✓'}</div><div><b>${esc(title)}</b><p class="muted small">${esc(txt)}</p></div></div>`).join('');
    $('#lodgingTimeline').innerHTML = stages.map(s=>`<div class="timeline-item ${statusClass(s)}"><div class="timeline-key">${s.key}</div><div><b>${esc(s.date)} · ${esc(s.to)}</b><p>${esc(s.lodging)}</p><span class="badge ${statusClass(s)}">${esc(s.statusLabel)}</span></div></div>`).join('');
  }
  function stageStatsHTML(s){
    return `<div class="info-tile"><div class="label">Distance</div><div class="value">${s.km} km</div></div><div class="info-tile"><div class="label">D+</div><div class="value">+${fmt(s.dp)} m</div></div><div class="info-tile"><div class="label">D-</div><div class="value">-${fmt(s.dm)} m</div></div><div class="info-tile"><div class="label">Durée</div><div class="value">${esc(s.duration)}</div></div>`;
  }
  function listHTML(items, cls='trek-list'){
    return `<ul class="${cls}">${(items||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;
  }
  function landmarkHTML(s){
    const items = s.landmarks || (s.points||[]).map(p=>({name:p,tag:'Repère',text:'Point remarquable de l’étape.'}));
    return items.map((l,idx)=>`<div class="landmark-card"><div class="landmark-rank">${idx+1}</div><div><div class="landmark-head"><b>${esc(l.name)}</b><span>${esc(l.tag||'Repère')}</span></div><p>${esc(l.text||'')}</p></div></div>`).join('');
  }
  function anecdoteHTML(s){
    return (s.anecdotes||[]).map(a=>`<article class="anecdote-card"><h4>${esc(a.title)}</h4><p>${esc(a.text)}</p></article>`).join('') || '<p class="muted">Anecdote à compléter.</p>';
  }
  function progressionHTML(s){
    return (s.progression||[]).map((p,idx)=>`<div class="progress-step"><div class="progress-dot">${idx+1}</div><div><b>${esc(p.label)}</b><p>${esc(p.note)}</p></div></div>`).join('');
  }
  function busTimesHTML(bus){
    if(!bus) return '';
    const aller = bus.depart_courmayeur_pmb;
    const retour = bus.depart_planpincieux;
    const arrets = (bus.arrets_cles||[]).map(a=>
      `<div class="bus-stop"><span class="bus-stop-role">${esc(a.role)}</span><b>${esc(a.nom)}</b><span class="bus-stop-note">${esc(a.note)}</span></div>`
    ).join('');
    const allerH = aller ? aller.horaires.map(h=>`<span class="bus-time">${h}</span>`).join('') : '';
    const retourH = retour ? retour.horaires.map(h=>`<span class="bus-time">${h}</span>`).join('') : '';
    const stratJ4 = bus.strategie_j4 ? `<div class="bus-strategy"><b>🌙 ${esc(bus.strategie_j4.titre)}</b><ol>${bus.strategie_j4.etapes.map(e=>`<li>${esc(e)}</li>`).join('')}</ol></div>` : '';
    const stratJ5 = bus.strategie_j5 ? `<div class="bus-strategy"><b>🌅 ${esc(bus.strategie_j5.titre)}</b><ol>${bus.strategie_j5.etapes.map(e=>`<li>${esc(e)}</li>`).join('')}</ol></div>` : '';
    const stratSimple = bus.horaires_recommandes ? `<div class="bus-strategy"><b>🌅 ${esc(bus.titre||'Reprise')}</b><p>Bus recommandés : ${bus.horaires_recommandes.map(h=>`<span class="bus-time">${h}</span>`).join(' ')}</p><p class="muted small">${esc(bus.note||'')}</p></div>` : '';
    return `
      <div class="bus-timetable">
        <div class="bus-header">
          <span class="bus-line-badge">🚌 Ligne 924</span>
          <span class="bus-tarif">${esc(bus.tarif||'2,20 € / trajet')}</span>
        </div>
        ${bus.note_ete ? `<div class="bus-alert">${esc(bus.note_ete)}</div>` : ''}
        ${aller ? `<div class="bus-direction"><div class="bus-dir-label">→ Courmayeur PMB vers Val Ferret</div><div class="bus-dir-note">${esc(aller.note||'')}</div><div class="bus-times">${allerH}</div><div class="bus-dir-note muted small">${esc(aller.temps_trajet||'')}</div></div>` : ''}
        ${retour ? `<div class="bus-direction"><div class="bus-dir-label">← Planpincieux vers Courmayeur</div><div class="bus-dir-note">${esc(retour.note||'')}</div><div class="bus-times">${retourH}</div></div>` : ''}
        ${arrets ? `<div class="bus-stops-title">Arrêts clés</div><div class="bus-stops">${arrets}</div>` : ''}
        ${stratJ4}${stratJ5}${stratSimple}
        <a class="bus-link" href="${esc(bus.liens?.horaires_officiels || bus.lien || 'https://aosta.arriva.it/en/courmayeur-mont-blanc/')}" target="_blank" rel="noopener">→ Horaires officiels Arriva (été publiés début juillet)</a>
      </div>`;
  }

  function logisticsHTML(s){
    if(!s.logistics) return '';
    const busBlock = s.logistics.bus ? busTimesHTML(s.logistics.bus) : '';
    return `<section class="trek-section transport-panel"><div class="section-mini"><span>🚌</span><h3>${esc(s.logistics.title || 'Logistique')}</h3></div><div class="transport-card">${listHTML(s.logistics.items||[], 'transport-list')}<p class="muted small">${esc(s.logistics.warning||'')}</p>${busBlock}</div></section>`;
  }
  function buildTrekBrief(s){
    const l=(s.landmarks||[]).map(x=>`- ${x.name} : ${x.tag||'repère'}`).join('\n');
    const v=(s.vigilance||[]).map(x=>`- ${x}`).join('\n');
    return `${s.key} · ${s.from} → ${s.to}
${s.date} · ${s.km} km · +${s.dp} m / -${s.dm} m · ${s.duration}

Briefing : ${s.briefing||s.trekNote}

À ne pas manquer :
${l}

Terrain : ${s.terrain||s.trekNote}

Logistique :
${s.logistics ? (s.logistics.items||[]).map(x=>`- ${x}`).join('\n') : '- Rien de spécifique.'}

Ravito / pauses : ${s.ravito||'À vérifier avant le départ.'}

Vigilance :
${v}

Hébergement : ${s.lodging}`;
  }

  function meteoUrl(s){
    const coord = s.coords && s.coords.length ? s.coords[Math.floor(s.coords.length/2)] : [45.9,6.9];
    return `https://www.meteoblue.com/fr/meteo/semaine/${coord[0].toFixed(4)}N${coord[1].toFixed(4)}E`;
  }
  function emergencyNumbers(s){
    const c = (s.country||'').toLowerCase();
    if(c.includes('italie') || c.includes('italy')) return '118 · Secours montagne IT';
    if(c.includes('suisse') || c.includes('swiss')) return '144 · Rega hélico CH';
    return '112 · PGHM 04 50 53 16 89';
  }
  function renderTrekCard(){
    const s=stages[selectedStage];
    $('#trekCard').innerHTML = `<div class="trek-hero"><div><span class="badge ${statusClass(s)}">${esc(s.badge)}</span><h3>${esc(s.key)} · ${esc(s.from)} → ${esc(s.to)}</h3><p class="muted">${esc(s.date)} · ${esc(s.country)} · difficulté ${esc(s.difficulty)}</p></div><div class="trek-hero-actions"><button class="btn" data-copy-brief="${selectedStage}">Copier le briefing</button><button class="btn btn-primary" data-play-stage="${selectedStage}">▶ Aperçu</button></div></div><div class="trek-stats">${stageStatsHTML(s)}</div><div class="trek-intro"><p>${esc(s.briefing||s.trekNote)}</p><div class="mood-chip">${esc(s.mood||'Ambiance de l’étape')}</div></div><div class="trek-enriched">${logisticsHTML(s)}<section class="trek-section landmarks"><div class="section-mini"><span>📍</span><h3>À ne pas manquer aujourd’hui</h3></div><div class="landmark-grid">${landmarkHTML(s)}</div></section><section class="trek-section"><div class="section-mini"><span>💡</span><h3>Le saviez-vous ?</h3></div><div class="anecdote-grid">${anecdoteHTML(s)}</div></section><section class="trek-section terrain-panel"><div class="terrain-card"><h3>Conseil terrain</h3><p>${esc(s.terrain||s.trekNote)}</p></div><div class="terrain-card"><h3>Pause / ravito</h3><p>${esc(s.ravito||'À vérifier avant le départ.')}</p></div><div class="terrain-card danger-soft"><h3>Vigilance</h3>${listHTML(s.vigilance||[], 'vigilance-list')}</div></section><section class="trek-section"><div class="section-mini"><span>🧭</span><h3>Repères de progression</h3></div><div class="progression-list">${progressionHTML(s)}</div></section><section class="trek-section trek-bottom"><div class="glass-card"><h3>Profil altimétrique</h3><canvas class="mini-profile" data-profile="${selectedStage}" data-h="145"></canvas><p class="muted small">Départ ${fmt(s.alt_start)} m · max ${fmt(s.alt_max)} m · arrivée ${fmt(s.alt_end)} m.</p></div><div class="glass-card"><h3>Mémo du soir</h3><p><b>Hébergement :</b> ${esc(s.lodging)}</p><p><b>Focus sac :</b> ${esc(s.packFocus)}</p><p><b>Indice d’effort :</b> ${esc(s.effort)} · ${esc(s.difficulty)}.</p></div></section></div><section class=\"trek-section\"><div class=\"section-mini\"><span>🛠</span><h3>Outils terrain</h3></div><div class=\"utility-grid\"><a class=\"utility-card weather\" href=\"${meteoUrl(s)}\" target=\"_blank\" rel=\"noopener\"><span class=\"utility-icon\">🌤</span><div><b>Météo du col</b><span>Ouvrir Météo Blue</span></div></a><div class=\"utility-card emergency\"><span class=\"utility-icon\">🆘</span><div><b>Urgences</b><span>${emergencyNumbers(s)}</span></div></div><button class=\"utility-card share\" id=\"shareLocBtn\"><span class=\"utility-icon\">📍</span><div><b>Ma position</b><span>Partager le lien</span></div></button>${s.logistics ? '<a class=\"utility-card bus\" href=\"https://www.arriva.vda.it/en/routes-and-timetables\" target=\"_blank\" rel=\"noopener\"><span class=\"utility-icon\">🚌</span><div><b>Bus Val Ferret</b><span>Horaires Arriva</span></div></a>' : ''}</div></section>`;
    setTimeout(()=>drawProfile($(`[data-profile="${selectedStage}"]`, $('#trekCard')), s, 1));
  }
  function renderStages(filter='all'){
    $('#stageCards').innerHTML = stages.map((s,i)=>({s,i})).filter(({s})=>filter==='all'||s.status===filter).map(({s,i})=>`<article class="stage-card ${statusClass(s)}" id="stage-${s.key}"><div class="stage-title-row"><div><span class="badge ${statusClass(s)}">${esc(s.badge)}</span><h3>${esc(s.key)} · ${esc(s.from)} → ${esc(s.to)}</h3><p class="muted small">${esc(s.date)} · ${esc(s.country)}</p></div></div><div class="stage-stats">${stageStatsHTML(s)}</div><canvas class="mini-profile" data-card-profile="${i}"></canvas><p><b>Hébergement :</b> ${esc(s.lodging)}</p><div class="points">${s.points.map(p=>`<span class="point">${esc(p)}</span>`).join('')}</div><details class="details"><summary>Voir la fiche complète</summary><p>${esc(s.trekNote)}</p><p><b>Altitude :</b> départ ${fmt(s.alt_start)} m · max ${fmt(s.alt_max)} m · arrivée ${fmt(s.alt_end)} m.</p><p><b>Indice d’effort :</b> ${esc(s.effort)} · ${esc(s.difficulty)}.</p><p><b>À prévoir :</b> ${esc(s.packFocus)}</p>${s.logistics ? `<div class="transport-card compact"><b>Logistique :</b>${listHTML(s.logistics.items||[], 'transport-list')}</div>` : ''}<div class="quick-actions"><button class="btn" data-goto="trek" data-select-stage="${i}">Ouvrir en mode trek</button><button class="btn" data-goto="map" data-select-stage="${i}">Voir sur la carte</button><button class="btn btn-primary" data-play-stage="${i}">Aperçu animé</button></div></details></article>`).join('');
    // Double rendu : immédiat + après layout pour les cartes hors viewport
    requestAnimationFrame(()=>{
      $all('[data-card-profile]').forEach(c=>drawProfile(c, stages[Number(c.dataset.cardProfile)], 1));
      setTimeout(()=>$all('[data-card-profile]').forEach(c=>drawProfile(c, stages[Number(c.dataset.cardProfile)], 1)), 300);
    });
  }
  function renderBudget(){
    const rows = [...budget.committed, ...budget.forecast, ...budget.unknown];
    $('#budgetView').innerHTML = `<div class="budget-metrics"><div class="info-tile"><div class="label">Déjà engagé</div><div class="value">${eur(budget.committed.reduce((a,b)=>a+b.amount,0))}</div></div><div class="info-tile"><div class="label">Prévisionnel connu</div><div class="value">${eur(budget.forecast.reduce((a,b)=>a+b.amount,0))}</div></div><div class="info-tile"><div class="label">Total connu</div><div class="value">${eur(budget.knownTotal)}</div></div><div class="info-tile"><div class="label">Par personne</div><div class="value">${budget.knownPerPerson.toLocaleString('fr-FR')} €</div></div></div><p class="muted small">Total hors nuit J4, encore à confirmer. Coût indicatif par personne et par nuit connue : ${budget.knownPerPersonNight.toLocaleString('fr-FR')} €.</p><div class="budget-table">${rows.map(r=>`<div class="budget-row"><span class="badge ${(r.status==='à confirmer'||r.status==='à réserver')?'missing':r.status==='prévisionnel'?'bivouac':'confirmed'}">${esc(r.stage)}</span><div><b>${esc(r.label)}</b><p class="muted small">${esc(r.payer)} · ${esc(r.status)}</p></div><div class="amount">${eur(r.amount)}</div></div>`).join('')}</div>`;
  }
  function localGet(key, fallback='{}'){
    try{ return localStorage.getItem(key) || fallback; }
    catch(e){ return fallback; }
  }
  function localSet(key, val){
    try{ localStorage.setItem(key, val); }
    catch(e){ toast('Stockage indisponible en navigation privée'); }
  }
  function renderChecklist(){
    const state = JSON.parse(localGet('tmb-checklist-v2', '{}'));
    $('#checklistGrid').innerHTML = checklist.map((group,gi)=>`<article class="check-card"><h3>${esc(group.category)}</h3>${group.items.map((item,ii)=>{ const key=`${gi}-${ii}`; return `<div class="check-item"><input type="checkbox" id="check-${key}" data-check-key="${key}" ${state[key]?'checked':''}><label for="check-${key}">${esc(item)}</label></div>`; }).join('')}</article>`).join('');
    $('#groupNotes').value = localGet('tmb-notes-v2', '') || '';
  }
  function saveChecklist(){ const state={}; $all('[data-check-key]').forEach(input=>state[input.dataset.checkKey]=input.checked); localSet('tmb-checklist-v2',JSON.stringify(state)); }
  function checklistSummary(){
    const total=$all('[data-check-key]').length; const done=$all('[data-check-key]').filter(i=>i.checked).length;
    return `Checklist TMB : ${done}/${total} points cochés. Notes : ${$('#groupNotes').value || '—'}`;
  }

  function initMap(){
    if(map) { refreshMapSize(); return; }
    const fallback = () => { $('#map').hidden = true; const c=$('#mapFallback'); c.hidden=false; drawFallbackMap(c, selectedStage); };
    if(!window.L){ fallback(); return; }
    try{
      $('#map').hidden = false;
      $('#mapFallback').hidden = true;
      map = L.map('map', {scrollWheelZoom:false, preferCanvas:true, zoomControl:true, tap:false, tapTolerance:15});
      addTileLayer(0);
      layers.route = L.polyline(routeCoords, {color:'#17352a', weight:3, opacity:.42}).addTo(map);
      layers.stageLines = stages.map((s,i)=>{
        const isActive = i===selectedStage;
        return L.polyline(s.coords,{
          color: isActive ? colorFor(s) : '#8fa89a',
          weight: isActive ? 9 : 3,
          opacity: isActive ? 1 : .45,
          lineCap:'round', lineJoin:'round'
        }).addTo(map).on('click',()=>{selectStage(i); switchTab('trek');});
      });
      layers.markers = stagePoints.map((p,i)=>{
        const stageIdx = i > 0 && i < stages.length ? i-1 : null;
        const s = stageIdx !== null ? stages[Math.min(stageIdx, stages.length-1)] : null;
        const popupContent = s
          ? `<div class="map-popup"><b>${esc(p.label)}</b><br><span>${esc(s.lodging||'')}</span><br><small>${esc(s.date||'')} · alt. ${s.alt_end||''}m</small></div>`
          : `<div class="map-popup"><b>${esc(p.label)}</b></div>`;
        return L.circleMarker([p.lat,p.lon], {
          radius: i===0 || i===stagePoints.length-1 ? 9 : 7,
          color:'#fff', weight:2.5,
          fillColor: s ? (s.status==='confirmed'?'#254c3a':s.status==='bivouac'?'#b8912e':s.status==='missing'?'#b95732':'#437c90') : '#17201d',
          fillOpacity:1
        }).bindPopup(popupContent, {maxWidth:220}).bindTooltip(esc(p.label), {direction:'top'}).addTo(map);
      });
      map.fitBounds(L.latLngBounds(routeCoords), {padding:[18,18]});
      map.whenReady(()=>{ refreshMapSize(); attachMapResizeObserver(); });
      highlightMapStage(selectedStage,true);
    }catch(e){ console.warn(e); fallback(); }
  }
  function addTileLayer(sourceIndex=0){
    if(!map) return;
    const source = TILE_SOURCES[sourceIndex] || TILE_SOURCES[0];
    activeTileSource = sourceIndex;
    if(activeTileLayer) map.removeLayer(activeTileLayer);
    let tileErrors = 0;
    activeTileLayer = L.tileLayer(source.url, {
      ...source.options,
      crossOrigin:true,
      updateWhenIdle:true,
      keepBuffer:4
    });
    activeTileLayer.on('tileerror', () => {
      tileErrors += 1;
      if(tileErrors >= 8 && TILE_SOURCES[sourceIndex + 1]) addTileLayer(sourceIndex + 1);
    });
    activeTileLayer.addTo(map);
  }
  function refreshMapSize(){
    if(!map) return;
    try{ map.invalidateSize({animate:false, pan:false}); }catch(e){}
    setTimeout(()=>{ try{ map.invalidateSize({animate:false, pan:false}); }catch(e){} }, 300);
  }
  function attachMapResizeObserver(){
    const el = document.getElementById('map');
    if(!el || !window.ResizeObserver) return;
    new ResizeObserver(()=>{ if(map) try{ map.invalidateSize({animate:false, pan:false}); }catch(e){} }).observe(el);
  }
  function reloadMapTiles(){
    if(!map) return;
    addTileLayer(activeTileSource);
    refreshMapSize();
    toast('Carte rechargée');
  }
  function highlightMapStage(i, fit=true){
    if(!map || !layers.stageLines) return;
    layers.stageLines.forEach((l,idx)=>{
      l.setStyle({
        color: idx===i ? colorFor(stages[idx]) : '#8fa89a',
        weight: idx===i ? 9 : 3,
        opacity: idx===i ? 1 : .45
      });
      if(idx===i) l.bringToFront();
    });
    if(fit) map.fitBounds(L.latLngBounds(stages[i].coords), {padding:[28,28]});
  }
  function renderMapButtons(){ $('#mapStageButtons').innerHTML = `<button class="chip is-active" data-map-stage="all">Tour complet</button>` + stages.map((s,i)=>`<button class="chip" data-map-stage="${i}">${s.key}</button>`).join('') + `<button class="chip" data-map-reload="1">↻ Recharger</button><button class="chip" data-map-recenter="1">⌖ Recentrer</button>`; }
  function drawFallbackMap(canvas, i){ const {ctx,w,h}=setCanvas(canvas, Math.min(640, Math.max(340, Math.floor(innerHeight*.58)))); ctx.fillStyle='#17201d'; ctx.fillRect(0,0,w,h); const all=project(routeCoords,w,h,24); drawPath(ctx,all,'rgba(255,255,255,.32)',3,1,1); const pts=project(stages[i].coords,w,h,24); drawPath(ctx,pts,colorFor(stages[i]),6,1,1); ctx.fillStyle='#fff'; ctx.font='900 16px system-ui'; ctx.fillText(`Carte simplifiée · ${stages[i].key}`,22,32); }

  function switchTab(name){
    $all('.nav-pill').forEach(b=>b.classList.toggle('is-active',b.dataset.tab===name));
    $all('.tab-panel').forEach(p=>p.classList.toggle('is-active',p.dataset.panel===name));
    if(name==='map'){
      setTimeout(()=>{ initMap(); }, 120);
      setTimeout(()=>{ refreshMapSize(); }, 500);
    }
    if(name==='stages'){
      requestAnimationFrame(()=>{
        setTimeout(()=>$all('[data-card-profile]').forEach(c=>drawProfile(c, stages[Number(c.dataset.cardProfile)], 1)), 80);
        setTimeout(()=>$all('[data-card-profile]').forEach(c=>drawProfile(c, stages[Number(c.dataset.cardProfile)], 1)), 400);
      });
    }
    window.scrollTo({top:document.querySelector('.app-nav').offsetTop,behavior:'smooth'});
  }
  function bindEvents(){
    document.addEventListener('click', async e=>{
      const tab=e.target.closest('[data-tab]'); if(tab){ switchTab(tab.dataset.tab); return; }
      const go=e.target.closest('[data-goto]'); if(go){ if(go.dataset.selectStage!=null) selectStage(Number(go.dataset.selectStage)); switchTab(go.dataset.goto); return; }
      const stageBtn=e.target.closest('[data-stage-button]'); if(stageBtn){ selectStage(Number(stageBtn.dataset.stageButton)); return; }
      const play=e.target.closest('[data-play-stage]'); if(play){ selectStage(Number(play.dataset.playStage)); switchTab('dashboard'); setTimeout(()=>startVideo(false),120); return; }
      const copyBrief=e.target.closest('[data-copy-brief]'); if(copyBrief){ const s=stages[Number(copyBrief.dataset.copyBrief)]; const text=buildTrekBrief(s); try{ await navigator.clipboard.writeText(text); toast('Briefing copié'); }catch{ toast('Copie indisponible'); } return; }
      const detail=e.target.closest('[data-stage-detail]'); if(detail){ selectStage(Number(detail.dataset.stageDetail)); switchTab('stages'); setTimeout(()=>document.getElementById(`stage-${stages[selectedStage].key}`)?.scrollIntoView({behavior:'smooth',block:'center'}),120); return; }
      const mapReload=e.target.closest('[data-map-reload]'); if(mapReload){ reloadMapTiles(); return; }

      const fsBtn = e.target.closest('#mapFullscreenBtn');
      if(fsBtn){
        const wrap = document.querySelector('.map-wrap');
        const isFs = wrap.classList.toggle('is-fullscreen');
        fsBtn.textContent = isFs ? '✕' : '⛶';
        fsBtn.setAttribute('aria-label', isFs ? 'Quitter le plein écran' : 'Plein écran');
        if(isFs) document.body.style.overflow = 'hidden';
        else document.body.style.overflow = '';
        setTimeout(()=>refreshMapSize(), 80);
        return;
      }
      const mapRecenter=e.target.closest('[data-map-recenter]'); if(mapRecenter){ if(map){ map.fitBounds(L.latLngBounds(routeCoords),{padding:[18,18]}); refreshMapSize(); toast('Carte recentrée'); } return; }
      const mapStage=e.target.closest('[data-map-stage]'); if(mapStage){ $all('[data-map-stage]').forEach(b=>b.classList.remove('is-active')); mapStage.classList.add('is-active'); if(mapStage.dataset.mapStage==='all'){ if(map) { map.fitBounds(L.latLngBounds(routeCoords),{padding:[18,18]}); refreshMapSize(); } } else { selectStage(Number(mapStage.dataset.mapStage)); highlightMapStage(selectedStage,true); refreshMapSize(); } return; }
      const filter=e.target.closest('[data-filter]'); if(filter){ $all('[data-filter]').forEach(b=>b.classList.remove('is-active')); filter.classList.add('is-active'); renderStages(filter.dataset.filter); return; }
    });
    $('#playSelected').addEventListener('click',()=> playing ? (playing=false, $('#playSelected').textContent='▶ Reprendre') : startVideo(false));
    $('#playAll').addEventListener('click',()=> playing ? (playing=false, playAllMode=false, $('#playAll').textContent='Lire les 9 étapes') : startVideo(true));
    $('#progressShell').addEventListener('pointerdown', e=>{ const r=e.currentTarget.getBoundingClientRect(); progress=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)); playing=false; drawVideo(); });
    $('#prevStage').addEventListener('click',()=>selectStage(selectedStage-1)); $('#nextStage').addEventListener('click',()=>selectStage(selectedStage+1)); $('#stageSelect').addEventListener('change',e=>selectStage(Number(e.target.value)));
    $('#printBtn').addEventListener('click',()=>window.print());
    $('#resetChecklist').addEventListener('click',()=>{ try{ localStorage.removeItem('tmb-checklist-v2'); }catch(e){} renderChecklist(); toast('Checklist réinitialisée'); });
    $('#exportChecklist').addEventListener('click',async()=>{ try{ await navigator.clipboard.writeText(checklistSummary()); toast('Bilan copié'); }catch{ toast(checklistSummary()); } });
    $('#checklistGrid').addEventListener('change',e=>{ if(e.target.matches('[data-check-key]')) saveChecklist(); });
    $('#groupNotes').addEventListener('input',e=>localSet('tmb-notes-v2',e.target.value));
    document.addEventListener('click', e=>{
      if(e.target.closest('#shareLocBtn')){
        if(!navigator.geolocation){ toast('Géolocalisation indisponible'); return; }
        navigator.geolocation.getCurrentPosition(pos=>{
          const url = `https://maps.google.com/maps?q=${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)}`;
          if(navigator.share){ navigator.share({title:'Ma position TMB', url}); }
          else if(navigator.clipboard){ navigator.clipboard.writeText(url).then(()=>toast('Lien copié !')); }
          else { prompt('Copie ce lien :', url); }
        }, ()=>toast('Position refusée ou indisponible'));
      }
    });
    window.addEventListener('resize',()=>{ drawVideo(); $all('[data-card-profile]').forEach(c=>drawProfile(c, stages[Number(c.dataset.cardProfile)], 1)); const cp=$(`[data-profile="${selectedStage}"]`, $('#trekCard')); if(cp) drawProfile(cp, stages[selectedStage], 1); if($('#mapFallback') && !$('#mapFallback').hidden) drawFallbackMap($('#mapFallback'),selectedStage); refreshMapSize(); });
  }

  function initDarkMode(){
    // Le site est toujours en dark mode — c'est le design de base
    document.documentElement.classList.add('dark');
    // On respecte quand même la préférence explicite light si l'utilisateur l'a sauvegardée
    try {
      const saved = localStorage.getItem('tmb-theme');
      if(saved === 'light') document.documentElement.classList.remove('dark');
    } catch(e) {}
  }

  // ── Météo hero ──────────────────────────────────────────────────────────
  const WEATHER_STAGES = [
    { label:'Contamines-Montjoie', lat:45.8226, lon:6.7253 },
    { label:'Col du Bonhomme',     lat:45.7351, lon:6.7065 },
    { label:'Col de la Seigne',    lat:45.7515, lon:6.8068 },
    { label:'Refuge Bonatti',      lat:45.8468, lon:7.0332 },
    { label:'Grand Col Ferret',    lat:45.8890, lon:7.0779 },
    { label:'Champex-Lac',         lat:46.0301, lon:7.1166 },
    { label:'Col de Balme',        lat:46.0273, lon:6.9706 },
    { label:'La Flégère',          lat:45.9599, lon:6.8870 },
    { label:'Brévent',             lat:45.9339, lon:6.8369 },
  ];
  const WMO_CODES = {
    0:'Dégagé',1:'Peu nuageux',2:'Partiellement nuageux',3:'Couvert',
    45:'Brouillard',48:'Brouillard givrant',
    51:'Bruine légère',53:'Bruine',55:'Bruine dense',
    61:'Pluie légère',63:'Pluie',65:'Pluie forte',
    71:'Neige légère',73:'Neige',75:'Neige forte',
    77:'Grésil',80:'Averses légères',81:'Averses',82:'Averses fortes',
    85:'Averses de neige',86:'Averses de neige fortes',
    95:'Orage',96:'Orage avec grêle',99:'Orage fort'
  };
  const WMO_ICON = {
    0:'☀️',1:'🌤',2:'⛅',3:'☁️',45:'🌫',48:'🌫',
    51:'🌦',53:'🌧',55:'🌧',61:'🌦',63:'🌧',65:'🌧',
    71:'🌨',73:'❄️',75:'❄️',77:'🌨',80:'🌦',81:'🌧',82:'🌧',
    85:'🌨',86:'❄️',95:'⛈',96:'⛈',99:'⛈'
  };

  async function fetchHeroWeather(retry=0){
    const el = $('#heroWeather');
    if(!el) return;
    // On prend les 3 points les plus représentatifs : un col bas, un col haut, un refuge
    const spots = [WEATHER_STAGES[0], WEATHER_STAGES[4], WEATHER_STAGES[7]];
    try{
      // Open-Meteo API — gratuite, sans clé
      const results = await Promise.all(spots.map(s =>
        fetch(`https://api.open-meteo.com/v1/forecast?latitude=${s.lat}&longitude=${s.lon}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max&timezone=Europe%2FParis&forecast_days=1&current_weather=true`)
          .then(r => r.json())
      ));

      const cards = results.map((data, i) => {
        const s = spots[i];
        const cur = data.current_weather || {};
        const code = cur.weathercode ?? (data.daily?.weathercode?.[0] ?? 0);
        const icon = WMO_ICON[code] || '🌡';
        const desc = WMO_CODES[code] || 'N/A';
        const tMax = data.daily?.temperature_2m_max?.[0];
        const tMin = data.daily?.temperature_2m_min?.[0];
        const wind = data.daily?.windspeed_10m_max?.[0];
        const rain = data.daily?.precipitation_sum?.[0];
        const tempStr = tMax != null ? `${Math.round(tMin)}–${Math.round(tMax)}°C` : '—';
        const alert = (wind > 50 || code >= 95) ? 'hw-card--alert' : (code >= 61 || rain > 5) ? 'hw-card--warn' : '';
        return `<a class="hw-card ${alert}" href="https://www.meteoblue.com/fr/meteo/semaine/${s.lat}N${s.lon}E" target="_blank" rel="noopener" title="Voir la météo complète">
          <span class="hw-icon">${icon}</span>
          <div class="hw-info">
            <b class="hw-place">${esc(s.label)}</b>
            <span class="hw-desc">${esc(desc)}</span>
            <span class="hw-temp">${tempStr}${wind != null ? ` · 💨 ${Math.round(wind)} km/h` : ''}</span>
          </div>
        </a>`;
      });

      const now = new Date();
      const dateStr = now.toLocaleDateString('fr-FR', {weekday:'long', day:'numeric', month:'long'});
      el.innerHTML = `<div class="hw-header"><span class="hw-date">Météo · ${dateStr}</span><span class="hw-source">Open-Meteo</span></div><div class="hw-cards">${cards.join('')}</div>`;

    } catch(e) {
      if(retry < 2){
        setTimeout(()=>fetchHeroWeather(retry+1), 3000 * (retry+1));
      } else {
        el.innerHTML = `<div class="hw-error"><a href="https://meteo.chamonix.fr" target="_blank" rel="noopener" class="hw-link">🌤 Voir la météo du massif →</a></div>`;
      }
    }
  }
  // ────────────────────────────────────────────────────────────────────────
  function init(){
    initDarkMode(); renderHero(); renderDashboard();
    fetchHeroWeather(); renderStagePicker(); renderPrep(); renderTrekCard(); renderStages(); renderBudget(); renderChecklist(); renderMapButtons(); bindEvents(); drawVideo();
    if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  }
  init();
})();
