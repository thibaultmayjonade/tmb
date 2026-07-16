
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
  function cumulativeEffort(stage, ratio){
    // km-effort accumulé proportionnellement : distance + D+/100 + D-/300, pondéré par la progression sur le profil
    const p = stage.profile; if(!p || p.length < 2) return (stage.effort||0)*ratio;
    const limit = Math.max(1, Math.floor((p.length-1)*ratio));
    let dp=0, dm=0;
    for(let i=1;i<=limit;i++){ const d=p[i]-p[i-1]; if(d>0) dp+=d; else dm+=Math.abs(d); }
    const distPart = stage.km * ratio;
    // mise à l'échelle du dénivelé réel du profil vers le D+/D- officiel de l'étape
    const totalUp = (function(){let u=0;for(let i=1;i<p.length;i++){const d=p[i]-p[i-1];if(d>0)u+=d;}return u||1;})();
    const totalDn = (function(){let u=0;for(let i=1;i<p.length;i++){const d=p[i]-p[i-1];if(d<0)u+=Math.abs(d);}return u||1;})();
    const dpScaled = (dp/totalUp) * stage.dp;
    const dmScaled = (dm/totalDn) * stage.dm;
    return distPart + dpScaled/100 + dmScaled/300;
  }
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
  function drawRouteCanvas(){ /* canvas d'accueil retiré */ }
  function isDark(){ return document.documentElement.classList.contains('dark'); }
  function drawProfile(canvas, stage, ratio=1){
    if(!canvas) return;
    const {ctx,w,h}=setCanvas(canvas, Number(canvas.dataset.h) || (canvas.classList.contains('mini-profile') ? 96 : 150));
    const p=stage.profile, min=Math.min(...p), max=Math.max(...p), range=max-min || 1, pad={t:14,r:10,b:20,l:10};
    const color=colorFor(stage);
    const dark=isDark();
    const bg = dark ? '#1a2420' : '#fffdf8';
    const gridCol = dark ? 'rgba(255,255,255,.06)' : 'rgba(31,36,33,.08)';
    const txtCol = dark ? 'rgba(255,255,255,.75)' : 'rgba(31,36,33,.72)';
    ctx.clearRect(0,0,w,h); ctx.fillStyle=bg; ctx.fillRect(0,0,w,h);
    ctx.strokeStyle=gridCol; ctx.lineWidth=1; for(let i=1;i<4;i++){ const y=pad.t+(h-pad.t-pad.b)*i/4; ctx.beginPath(); ctx.moveTo(pad.l,y); ctx.lineTo(w-pad.r,y); ctx.stroke(); }
    const x=i => pad.l + (i/(p.length-1))*(w-pad.l-pad.r); const y=v => h-pad.b-((v-min)/range)*(h-pad.t-pad.b);
    const limit = Math.max(1, Math.floor((p.length-1)*ratio));
    const grad=ctx.createLinearGradient(0,0,0,h); grad.addColorStop(0,color+(dark?'55':'50')); grad.addColorStop(1,color+'08');
    ctx.beginPath(); ctx.moveTo(pad.l,h-pad.b); for(let i=0;i<=limit;i++) ctx.lineTo(x(i),y(p[i])); ctx.lineTo(x(limit),h-pad.b); ctx.closePath(); ctx.fillStyle=grad; ctx.fill();
    ctx.beginPath(); ctx.moveTo(x(0),y(p[0])); for(let i=1;i<=limit;i++) ctx.lineTo(x(i),y(p[i])); ctx.strokeStyle=color; ctx.lineWidth=2.5; ctx.lineJoin='round'; ctx.stroke();
    const curAlt=currentAlt(stage,ratio); ctx.fillStyle=txtCol; ctx.font='800 11px system-ui'; ctx.textAlign='left'; ctx.fillText(`${stage.alt_start} m`,pad.l,h-6); ctx.textAlign='center'; ctx.fillText(`max ${stage.alt_max} m`,w/2,h-6); ctx.textAlign='right'; ctx.fillText(`${stage.alt_end} m`,w-pad.r,h-6); ctx.textAlign='left';
    if(ratio < 1 && curAlt){
      const xi=x(limit), yi=y(curAlt);
      ctx.beginPath(); ctx.arc(xi,yi,5,0,Math.PI*2); ctx.fillStyle=color; ctx.fill();
      ctx.strokeStyle=dark?'#1a2420':'#fff'; ctx.lineWidth=2; ctx.stroke();
    }
  }
  // ── Moteur d'animation du profil altimétrique, ciblé sur un canvas d'étape ──
  let animState = { canvas:null, stageIdx:0, progress:0, playing:false, lastTs:null, infoEl:null };

  /* updateAnimInfo retiré */
  function drawAnim(){ if(animState.canvas) drawProfile(animState.canvas, stages[animState.stageIdx], animState.progress); updateCardAnimInfo(); }
  /* animTick retiré */
  /* startAnim retiré */
  /* resetAnim retiré */
  // ── Animation ciblée sur la carte d'étape d'index donné ──
  function startCardAnim(idx){
    const canvas = document.querySelector(`[data-anim-canvas="${idx}"]`);
    const info = document.querySelector(`[data-anim-info="${idx}"]`);
    const bar = document.querySelector(`[data-anim-bar="${idx}"]`);
    const btn = document.querySelector(`[data-anim-play="${idx}"]`);
    const speedEl = document.querySelector(`[data-anim-speed="${idx}"]`);
    if(!canvas) return;
    // (re)démarrage
    animState = { canvas, stageIdx: idx, progress: (animState.stageIdx===idx && animState.progress<1)?animState.progress:0, playing:true, lastTs:null, infoEl:info, bar, btn, speedEl };
    if(btn) btn.textContent = '⏸ Lecture';
    requestAnimationFrame(cardAnimTick);
  }
  function cardAnimTick(ts){
    if(!animState.playing){ animState.lastTs=null; return; }
    if(animState.lastTs==null) animState.lastTs=ts;
    const speed = animState.speedEl ? Number(animState.speedEl.value||1) : 1;
    animState.progress += (ts-animState.lastTs)/(BASE_DURATION/speed);
    animState.lastTs=ts;
    const done = animState.progress>=1;
    if(done) animState.progress=1;
    if(animState.canvas) drawProfile(animState.canvas, stages[animState.stageIdx], animState.progress);
    updateCardAnimInfo();
    if(done){ animState.playing=false; if(animState.btn) animState.btn.textContent='↻ Revoir'; return; }
    requestAnimationFrame(cardAnimTick);
  }
  function updateCardAnimInfo(){
    if(!animState.infoEl) return;
    const s=stages[animState.stageIdx], r=animState.progress;
    const km=cumulativeKm(s,r), alt=currentAlt(s,r), eff=cumulativeEffort(s,r);
    animState.infoEl.innerHTML = `<div class="anim-metrics"><div class="anim-metric"><span class="anim-metric__label">Distance</span><span class="anim-metric__value">${km.toFixed(1)}<small>/${s.km} km</small></span></div><div class="anim-metric"><span class="anim-metric__label">Altitude</span><span class="anim-metric__value">${alt||'—'}<small>m</small></span></div><div class="anim-metric anim-metric--effort ${effortClass(eff)}"><span class="anim-metric__label">Km-effort</span><span class="anim-metric__value">${eff.toFixed(1)}<small>/${s.effort}</small></span></div></div>`;
    if(animState.bar) animState.bar.style.width = `${Math.round(r*100)}%`;
  }
  // Compat : anciennes signatures neutralisées (le video-panel d'accueil a été retiré)
  function drawVideo(){ /* retiré de l'accueil */ }
  function startVideo(){ /* retiré : l'animation vit désormais dans les fiches d'étapes */ switchTab('stages'); }
  function selectStage(i){ selectedStage=Math.max(0,Math.min(stages.length-1,i)); animState.progress=0; animState.playing=false; animState.lastTs=null; updateAllSelected(); }
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
    const totalEffort = stages.reduce((sum,s)=>sum+(s.effort||0),0);
    $('#heroStats').innerHTML = `<div class="hero-stat"><b>${t.days}</b><span>jours</span></div><div class="hero-stat"><b>${String(t.km).replace('.',',')} km</b><span>distance</span></div><div class="hero-stat"><b>+${fmt(t.dp)} m</b><span>dénivelé +</span></div><div class="hero-stat"><b>${Math.round(totalEffort)}</b><span>km-effort total</span></div><div class="hero-stat"><b>${eur(t.knownBudget)}</b><span>budget connu</span></div>`;
  }
  function renderDashboard(){
    const t=DATA.meta.totals;
    const missing=stages.filter(s=>s.status==='missing').length;
    $('#dashboardCards').innerHTML = [
      ['🗓️',t.days,'jours de marche'], ['🥾',String(t.km).replace('.',','),'km marche estimés'], ['⛰️','+'+fmt(t.dp)+' m','D+ cumulé'], ['⚠️',missing,'point hébergement à régler']
    ].map((c,i)=>`<article class="metric-card ${i===3&&missing?'warning':''}"><div class="icon">${c[0]}</div><div class="value">${c[1]}</div><div class="label">${c[2]}</div></article>`).join('');
    const miss=stages.find(s=>s.status==='missing');
    if(miss){
      $('#priorityCard').innerHTML = `<div class="priority-eyebrow">⚠️ ACTION REQUISE</div><h3>Priorité actuelle</h3><p><b>${miss.key} · ${esc(miss.from)} → ${esc(miss.to)}</b></p><p>${esc(miss.lodging)}.</p><p class="muted small">${esc(miss.priorityText || 'À verrouiller : hébergement, horaires de navette et marge horaire.')}</p><button class="btn btn-primary" data-stage-detail="${stages.indexOf(miss)}">Ouvrir la fiche ${esc(miss.key)}</button>`;
    } else {
      // Toutes les nuits sont calées : afficher un rappel positif + prochaine action
      $('#priorityCard').innerHTML = `<div class="priority-eyebrow" style="color:#7ecfa0">✓ TOUT EST CALÉ</div><h3>Hébergements complets</h3><p>Les 8 nuits sont réservées ou planifiées, bivouacs inclus.</p><p class="muted small">Dernières actions : réserver le Camping Grandes Jorasses (J4), vérifier les horaires été 2026 du bus 924 et régler la Flégère sur place (216 €).</p><button class="btn btn-primary" data-stage-detail="3">Ouvrir la fiche J4</button>`;
    }
  }
  function renderStagePicker(){ /* stage-picker d'accueil retiré */ }
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
  function effortClass(e){
    if(e < 30) return 'effort-mod';
    if(e < 38) return 'effort-sou';
    if(e < 44) return 'effort-dif';
    return 'effort-max';
  }
  function stageStatsHTML(s){
    return `<div class="info-tile"><div class="label">Distance</div><div class="value">${s.km} km</div></div><div class="info-tile"><div class="label">D+</div><div class="value">+${fmt(s.dp)} m</div></div><div class="info-tile"><div class="label">D-</div><div class="value">-${fmt(s.dm)} m</div></div><div class="info-tile effort-tile ${effortClass(s.effort)}"><div class="label">Km-effort</div><div class="value">${s.effort}</div></div>`;
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
    $('#trekCard').innerHTML = `
      <div class="trek-hero">
        <div>
          <span class="badge ${statusClass(s)}">${esc(s.badge)}</span>
          <h3>${esc(s.key)} · ${esc(s.from)} → ${esc(s.to)}</h3>
          <p class="muted">${esc(s.date)} · ${esc(s.country)} · <span class="effort-badge ${effortClass(s.effort)}">${esc(s.effort)} km-effort</span> · ${esc(s.difficulty)}</p>
        </div>
        <div class="trek-hero-actions">
          <button class="btn" data-copy-brief="${selectedStage}">Copier le briefing</button>
        </div>
      </div>
      <div class="trek-stats">${stageStatsHTML(s)}</div>
      <section class="trek-section trek-profile-top">
        <div class="section-mini"><span>📈</span><h3>Profil altimétrique</h3></div>
        <canvas class="mini-profile" data-profile="${selectedStage}" data-h="170"></canvas>
        <p class="muted small">Départ ${fmt(s.alt_start)} m · max ${fmt(s.alt_max)} m · arrivée ${fmt(s.alt_end)} m · <b>${s.km} km</b> · +${fmt(s.dp)} m / -${fmt(s.dm)} m · <b>${s.effort} km-effort</b></p>
      </section>
      <details class="acc" open>
        <summary><span class="acc__icon">🧭</span> Briefing de l'étape</summary>
        <div class="acc__body">
          <div class="trek-intro"><p>${esc(s.briefing||s.trekNote)}</p><div class="mood-chip">${esc(s.mood||'Ambiance de l\'étape')}</div></div>
        </div>
      </details>
      ${s.logistics ? `<details class="acc" open><summary><span class="acc__icon">🚌</span> Logistique & transport</summary><div class="acc__body">${logisticsHTML(s)}</div></details>` : ''}
      <details class="acc">
        <summary><span class="acc__icon">📍</span> À ne pas manquer aujourd'hui</summary>
        <div class="acc__body"><div class="landmark-grid">${landmarkHTML(s)}</div></div>
      </details>
      <details class="acc">
        <summary><span class="acc__icon">💡</span> Le saviez-vous ?</summary>
        <div class="acc__body"><div class="anecdote-grid">${anecdoteHTML(s)}</div></div>
      </details>
      <details class="acc">
        <summary><span class="acc__icon">⛰️</span> Terrain, ravito & vigilance</summary>
        <div class="acc__body"><div class="terrain-panel"><div class="terrain-card"><h3>Conseil terrain</h3><p>${esc(s.terrain||s.trekNote)}</p></div><div class="terrain-card"><h3>Pause / ravito</h3><p>${esc(s.ravito||'À vérifier avant le départ.')}</p></div><div class="terrain-card danger-soft"><h3>Vigilance</h3>${listHTML(s.vigilance||[], 'vigilance-list')}</div></div></div>
      </details>
      <details class="acc">
        <summary><span class="acc__icon">🧭</span> Repères de progression</summary>
        <div class="acc__body"><div class="progression-list">${progressionHTML(s)}</div></div>
      </details>
      <details class="acc">
        <summary><span class="acc__icon">🛠</span> Outils terrain & mémo du soir</summary>
        <div class="acc__body">
          <div class="utility-grid"><a class="utility-card weather" href="${meteoUrl(s)}" target="_blank" rel="noopener"><span class="utility-icon">🌤</span><div><b>Météo du col</b><span>Ouvrir Météo Blue</span></div></a><div class="utility-card emergency"><span class="utility-icon">🆘</span><div><b>Urgences</b><span>${emergencyNumbers(s)}</span></div></div><button class="utility-card share" id="shareLocBtn"><span class="utility-icon">📍</span><div><b>Ma position</b><span>Partager le lien</span></div></button></div>
          <div class="glass-card" style="margin-top:12px"><h3>Mémo du soir</h3><p><b>Hébergement :</b> ${esc(s.lodging)}</p><p><b>Focus sac :</b> ${esc(s.packFocus)}</p><p><b>Km-effort :</b> <span class="effort-badge ${effortClass(s.effort)}">${esc(s.effort)}</span> · ${esc(s.difficulty)}</p></div>
        </div>
      </details>`;
    setTimeout(()=>drawProfile($(`[data-profile="${selectedStage}"]`, $('#trekCard')), s, 1));
  }
  function renderStages(filter='all'){
    $('#stageCards').innerHTML = stages.map((s,i)=>({s,i})).filter(({s})=>filter==='all'||s.status===filter).map(({s,i})=>`<article class="stage-card ${statusClass(s)}" id="stage-${s.key}">
      <div class="stage-title-row"><div><span class="badge ${statusClass(s)}">${esc(s.badge)}</span><h3>${esc(s.key)} · ${esc(s.from)} → ${esc(s.to)}</h3><p class="muted small">${esc(s.date)} · ${esc(s.country)}</p></div></div>
      <div class="stage-stats">${stageStatsHTML(s)}</div>
      <canvas class="mini-profile" data-card-profile="${i}"></canvas>
      <details class="acc acc--anim" data-anim-stage="${i}">
        <summary><span class="acc__icon">🎬</span> Aperçu animé du profil</summary>
        <div class="acc__body">
          <canvas class="anim-canvas" data-anim-canvas="${i}" data-h="150"></canvas>
          <div class="anim-controls">
            <button class="btn btn-primary anim-play" data-anim-play="${i}">▶ Lire le profil</button>
            <select class="anim-speed" data-anim-speed="${i}" aria-label="Vitesse"><option value="0.75">Doux</option><option value="1" selected>Normal</option><option value="1.5">Rapide</option><option value="2.5">Rapide+</option></select>
          </div>
          <div class="anim-progress"><div class="anim-progress-bar" data-anim-bar="${i}"></div></div>
          <div class="anim-info" data-anim-info="${i}"></div>
        </div>
      </details>
      <p class="stage-lodging"><b>Hébergement :</b> ${esc(s.lodging)}</p>
      <div class="points">${s.points.map(p=>`<span class="point">${esc(p)}</span>`).join('')}</div>
      <details class="acc">
        <summary><span class="acc__icon">📄</span> Fiche complète</summary>
        <div class="acc__body">
          <p>${esc(s.trekNote)}</p>
          <p><b>Altitude :</b> départ ${fmt(s.alt_start)} m · max ${fmt(s.alt_max)} m · arrivée ${fmt(s.alt_end)} m.</p>
          <p><b>Km-effort :</b> <span class="effort-badge ${effortClass(s.effort)}">${esc(s.effort)}</span> · ${esc(s.difficulty)} <span class="muted small">(${s.km} + ${s.effort_detail?s.effort_detail.from_dplus:Math.round(s.dp/100*10)/10} D+ + ${s.effort_detail?s.effort_detail.from_dmoins:Math.round(s.dm/300*10)/10} D-)</span></p>
          <p><b>À prévoir :</b> ${esc(s.packFocus)}</p>
          ${s.logistics ? `<div class="transport-card compact"><b>Logistique :</b>${listHTML(s.logistics.items||[], 'transport-list')}</div>` : ''}
          <div class="quick-actions"><button class="btn" data-goto="trek" data-select-stage="${i}">Ouvrir en mode trek</button></div>
        </div>
      </details>
    </article>`).join('');
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
    if(name==='sac'){ renderSac(); }
    window.scrollTo({top:document.querySelector('.app-nav').offsetTop,behavior:'smooth'});
  }
  function bindEvents(){
    document.addEventListener('click', async e=>{
      const tab=e.target.closest('[data-tab]'); if(tab){ switchTab(tab.dataset.tab); return; }
      const go=e.target.closest('[data-goto]'); if(go){ if(go.dataset.selectStage!=null) selectStage(Number(go.dataset.selectStage)); switchTab(go.dataset.goto); return; }
      const stageBtn=e.target.closest('[data-stage-button]'); if(stageBtn){ selectStage(Number(stageBtn.dataset.stageButton)); return; }
      const play=e.target.closest('[data-play-stage]'); if(play){ selectStage(Number(play.dataset.playStage)); switchTab('stages'); setTimeout(()=>{ const c=$('#stage-'+stages[selectedStage].key); if(c) c.scrollIntoView({behavior:'smooth',block:'start'}); },150); return; }
      const themeBtn=e.target.closest('#themeToggle'); if(themeBtn){ toggleTheme(); return; }
      const animPlay=e.target.closest('[data-anim-play]'); if(animPlay){ startCardAnim(Number(animPlay.dataset.animPlay)); return; }
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
    $('#prevStage').addEventListener('click',()=>selectStage(selectedStage-1)); $('#nextStage').addEventListener('click',()=>selectStage(selectedStage+1)); $('#stageSelect').addEventListener('change',e=>selectStage(Number(e.target.value)));
    $('#printBtn').addEventListener('click',()=>window.print());
    $('#resetChecklist').addEventListener('click',()=>{ try{ localStorage.removeItem('tmb-checklist-v2'); }catch(e){} renderChecklist(); toast('Checklist réinitialisée'); });
    $('#exportChecklist').addEventListener('click',async()=>{ try{ await navigator.clipboard.writeText(checklistSummary()); toast('Bilan copié'); }catch{ toast(checklistSummary()); } });
    $('#checklistGrid').addEventListener('change',e=>{ if(e.target.matches('[data-check-key]')) saveChecklist(); });
    // Vitesse d'animation : si on change pendant la lecture, rien à faire (lu dynamiquement). Au repos, ré-init de l'aperçu.
    document.addEventListener('change', e=>{ const sp=e.target.closest('[data-anim-speed]'); if(sp){ const idx=Number(sp.dataset.animSpeed); const cv=document.querySelector(`[data-anim-canvas="${idx}"]`); if(cv && !animState.playing){ drawProfile(cv, stages[idx], 0); const info=document.querySelector(`[data-anim-info="${idx}"]`); if(info){ animState={...animState,stageIdx:idx,progress:0,infoEl:info,canvas:cv}; updateCardAnimInfo(); } } } });
    // Ouverture d'un accordéon d'aperçu animé : dessiner le profil statique de départ
    document.addEventListener('click', e=>{ const sum=e.target.closest('.acc--anim > summary'); if(sum){ const det=sum.parentElement; const idx=Number(det.dataset.animStage); setTimeout(()=>{ const cv=document.querySelector(`[data-anim-canvas="${idx}"]`); if(cv && det.open){ drawProfile(cv, stages[idx], 0); const info=document.querySelector(`[data-anim-info="${idx}"]`); if(info){ const saved={...animState}; animState={canvas:cv,stageIdx:idx,progress:0,playing:false,lastTs:null,infoEl:info,bar:document.querySelector(`[data-anim-bar="${idx}"]`),btn:document.querySelector(`[data-anim-play="${idx}"]`),speedEl:document.querySelector(`[data-anim-speed="${idx}"]`)}; updateCardAnimInfo(); } } }, 60); } });
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
    window.addEventListener('resize',()=>{ drawAnim(); $all('[data-card-profile]').forEach(c=>drawProfile(c, stages[Number(c.dataset.cardProfile)], 1)); const cp=$(`[data-profile="${selectedStage}"]`, $('#trekCard')); if(cp) drawProfile(cp, stages[selectedStage], 1); if($('#mapFallback') && !$('#mapFallback').hidden) drawFallbackMap($('#mapFallback'),selectedStage); refreshMapSize(); });
  }

  function applyThemeButton(){
    const dark=isDark(); const btn=$('#themeToggle'); if(!btn) return;
    const icon=btn.querySelector('.theme-toggle__icon'), label=btn.querySelector('.theme-toggle__label');
    if(icon) icon.textContent = dark ? '☀️' : '🌙';
    if(label) label.textContent = dark ? 'Clair' : 'Sombre';
  }
  function initDarkMode(){
    // Dark par défaut ; la préférence explicite de l'utilisateur prime
    let saved=null; try{ saved=localStorage.getItem('tmb-theme'); }catch(e){}
    if(saved === 'light') document.documentElement.classList.remove('dark');
    else document.documentElement.classList.add('dark');
    applyThemeButton();
  }
  function toggleTheme(){
    const nowDark = document.documentElement.classList.toggle('dark');
    try{ localStorage.setItem('tmb-theme', nowDark ? 'dark' : 'light'); }catch(e){}
    applyThemeButton();
    // Redessiner tous les profils avec les bonnes couleurs
    $all('[data-card-profile]').forEach(c=>drawProfile(c, stages[Number(c.dataset.cardProfile)], 1));
    const tp=$(`[data-profile="${selectedStage}"]`, $('#trekCard')); if(tp) drawProfile(tp, stages[selectedStage], 1);
    if(animState.canvas) drawAnim();
    if(typeof fetchHeroWeather==='function'){} // météo inchangée
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

  /* ═══════════════════════════════════════════════════════════════
     ONGLET SAC (Khumbu 65+10) — intégré au thème du site
     Persistance via localGet/localSet (localStorage)
     ═══════════════════════════════════════════════════════════════ */
  const SAC_CATALOGUE = {
    "Couchage & nuit":[
      {n:"Sac de couchage",g:900,ideal:["bottom"],lourd:true},{n:"Sac à viande / drap sac",g:200,ideal:["bottom"]},
      {n:"Matelas gonflable",g:500,ideal:["bottom"]},{n:"Oreiller gonflable",g:80,ideal:["bottom"]},
      {n:"Bouchons d'oreilles",g:5,ideal:["lid_top"]},{n:"Masque de nuit",g:30,ideal:["bottom"]},
      {n:"Tongs / claquettes refuge",g:250,ideal:["bottom","straps"]},{n:"Vêtements de nuit",g:300,ideal:["bottom"]}],
    "Abri & tente":[
      {n:"Tente (toile)",g:1200,ideal:["main"],lourd:true},{n:"Arceaux de tente",g:500,ideal:["straps","main"],lourd:true},
      {n:"Sardines + haubans",g:200,ideal:["main"]},{n:"Tapis de sol / footprint",g:300,ideal:["bottom","straps"]}],
    "Cuisine & eau":[
      {n:"Réchaud",g:90,ideal:["main"]},{n:"Cartouche de gaz",g:200,ideal:["main"],lourd:true,sep_food:true},
      {n:"Popote / casserole",g:250,ideal:["main"]},{n:"Briquet / allumettes",g:20,ideal:["lid_top"]},
      {n:"Couteau / Opinel",g:60,ideal:["lid_top"]},{n:"Spork / couverts",g:20,ideal:["main"]},
      {n:"Éponge + savon bio",g:30,ideal:["main"]},{n:"Mug / gobelet",g:80,ideal:["main"]},
      {n:"Poche à eau 2 L (pleine)",g:2000,ideal:["hydration"],lourd:true},{n:"Gourde 1 L (pleine)",g:1000,ideal:["mesh_left","mesh_right"],lourd:true},
      {n:"Pastilles / filtre à eau",g:60,ideal:["lid_top"]},{n:"Électrolytes / iso",g:100,ideal:["lid_top"]}],
    "Vêtements":[
      {n:"T-shirt technique",g:150,ideal:["main"]},{n:"Sous-couche manches longues",g:200,ideal:["main"]},
      {n:"Short / pantalon de rando",g:300,ideal:["main"]},{n:"Sous-vêtements",g:150,ideal:["main"]},
      {n:"Chaussettes de rando",g:80,ideal:["main"]},{n:"Polaire / midlayer",g:350,ideal:["main"]},
      {n:"Doudoune compressible",g:350,ideal:["main"]},{n:"Veste imperméable",g:350,ideal:["front"]},
      {n:"Surpantalon imperméable",g:250,ideal:["front"]},{n:"Gants",g:60,ideal:["lid_top","front"]},
      {n:"Bonnet / tour de cou",g:60,ideal:["lid_top","front"]},{n:"Casquette / chapeau",g:70,ideal:["lid_top","front"]},
      {n:"Lunettes de soleil",g:30,ideal:["lid_top"]}],
    "Alimentation":[
      {n:"Barres énergétiques",g:200,ideal:["lid_top","hipbelt"]},{n:"Fruits secs / oléagineux",g:200,ideal:["lid_top"]},
      {n:"Repas lyophilisé",g:150,ideal:["main"]},{n:"En-cas salés",g:150,ideal:["lid_top"]},
      {n:"Café / thé",g:50,ideal:["main"]},{n:"Pique-nique du midi",g:400,ideal:["lid_top","front"]}],
    "Hygiène & toilette":[
      {n:"Brosse à dents + dentifrice",g:50,ideal:["main"]},{n:"Savon biodégradable",g:60,ideal:["main"]},
      {n:"Papier toilette",g:60,ideal:["lid_top"]},{n:"Gel hydroalcoolique",g:60,ideal:["lid_top"]},
      {n:"Crème solaire",g:100,ideal:["lid_top"]},{n:"Stick lèvres",g:15,ideal:["lid_top","hipbelt"]},
      {n:"Serviette microfibre",g:120,ideal:["bottom","main"]},{n:"Mouchoirs",g:30,ideal:["lid_top"]}],
    "Pharmacie & sécurité":[
      {n:"Pansements ampoules",g:40,ideal:["lid_top"]},{n:"Strapping / élasto",g:60,ideal:["lid_top"]},
      {n:"Antalgiques / anti-inflam.",g:40,ideal:["lid_under"]},{n:"Désinfectant",g:40,ideal:["lid_top"]},
      {n:"Couverture de survie",g:60,ideal:["lid_top"]},{n:"Sifflet",g:10,ideal:["lid_top","hipbelt"]},
      {n:"Pince à tiques",g:10,ideal:["lid_top"]},{n:"Crème anti-frottement",g:50,ideal:["lid_top"]},
      {n:"Traitement personnel",g:50,ideal:["lid_under"]}],
    "Papiers & navigation":[
      {n:"Carte IGN / topoguide",g:150,ideal:["lid_top","front"]},{n:"Boussole",g:40,ideal:["lid_top"]},
      {n:"Papiers d'identité",g:30,ideal:["lid_under"]},{n:"CB / carte d'assurance",g:20,ideal:["lid_under"]},
      {n:"Cash EUR + CHF",g:40,ideal:["lid_under"]},{n:"Réservations refuges",g:20,ideal:["lid_under"]},
      {n:"Montre GPS",g:60,ideal:["lid_top"]}],
    "Électronique":[
      {n:"Téléphone",g:200,ideal:["lid_under","lid_top"]},{n:"Batterie externe",g:250,ideal:["lid_under","main"],lourd:true},
      {n:"Câbles de charge",g:60,ideal:["lid_top"]},{n:"Frontale + piles",g:90,ideal:["lid_top"]},
      {n:"Écouteurs",g:30,ideal:["lid_top"]},{n:"Adaptateur suisse",g:40,ideal:["main"]},
      {n:"Appareil photo",g:400,ideal:["lid_top","front"],lourd:true}],
    "Portage & accessoires":[
      {n:"Bâtons de marche",g:500,ideal:["straps"]},{n:"Housse de pluie du sac",g:120,ideal:["front"]},
      {n:"Sacs étanches",g:80,ideal:["main"]},{n:"Cordelette / paracorde",g:40,ideal:["lid_top"]},
      {n:"Mousquetons",g:40,ideal:["straps"]},{n:"Épingles à nourrice",g:5,ideal:["lid_top"]}],
  };
  const SAC_META = {};
  for(const [cat,arr] of Object.entries(SAC_CATALOGUE)) for(const o of arr) SAC_META[o.n]={...o,cat};

  const POCKETS = [
    {id:'lid_top',name:'Poche supérieure du rabat',role:'Petit, accès en marche.',vpos:'haut',side:'centre'},
    {id:'lid_under',name:'Poche intérieure du rabat',role:'Sécurité, contre la tête.',vpos:'haut',side:'centre'},
    {id:'main',name:'Compartiment principal',role:'Gros volume, chargement par le haut.',vpos:'haut',side:'centre'},
    {id:'hydration',name:'Poche à eau interne',role:'Manchon 2 L contre le dos.',vpos:'haut',side:'centre'},
    {id:'front',name:'Grande poche frontale',role:'Poche plate, accès rapide.',vpos:'haut',side:'centre'},
    {id:'bottom',name:'Compartiment bas zippé',role:'Accès séparé par le bas.',vpos:'bas',side:'centre'},
    {id:'mesh_left',name:'Filet latéral gauche',role:'À portée de main.',vpos:'bas',side:'gauche'},
    {id:'mesh_right',name:'Filet latéral droit',role:'À portée de main.',vpos:'bas',side:'droite'},
    {id:'straps',name:'Compression + porte-bâtons',role:'Externe, sanglé.',vpos:'bas',side:'centre'},
    {id:'hipbelt',name:'Ceinture lombaire',role:'Poches de ceinture, si équipée.',vpos:'bas',side:'centre'},
  ];
  const PMAP = Object.fromEntries(POCKETS.map(p=>[p.id,p]));
  const escSac = s => (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const normSac = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');

  let sacPack = [];      // [{id,name,pocket,g}]
  let sacSel = null;
  let sacAddOpen = false;
  let sacHoverCat = null;
  let sacInited = false;

  // Liste rapide (sous-onglet)
  const LIST_ZONES = POCKETS.map(p=>({id:p.id,label:p.name}));
  let sacListItems = [];  // [{id,name,zone,g}]
  let sacListFilter = null;
  let sacListQuery = '';

  function loadSacData(){
    try{ sacPack = JSON.parse(localGet('tmb-sac-pack','[]')); }catch(e){ sacPack=[]; }
    try{ sacListItems = JSON.parse(localGet('tmb-sac-list','[]')); }catch(e){ sacListItems=[]; }
  }
  function saveSacPack(){ localSet('tmb-sac-pack', JSON.stringify(sacPack)); }
  function saveSacList(){ localSet('tmb-sac-list', JSON.stringify(sacListItems)); }

  /* ── SVG du sac 10 poches (classes .szone, thème-aware) ── */
  function sacSVG(counts){
    const c = id => { const n = counts[id]||0; return n?n:'—'; };
    return `
    <svg viewBox="0 0 260 430" role="img" aria-label="Schéma du sac à 10 poches">
      <ellipse cx="130" cy="416" rx="86" ry="10" fill="#000" opacity=".14"/>
      <path d="M40 60 C24 150,24 300,40 392 L30 392 C12 300,12 150,30 54 Z" fill="var(--glacier)" opacity=".14"/>
      <text x="24" y="230" class="zcount" transform="rotate(-90 24 230)" text-anchor="middle" opacity=".5">CONTRE LE DOS</text>
      <rect x="44" y="66" width="172" height="330" rx="16" class="sac-body-fill" stroke="var(--border)" stroke-width="1.6"/>
      <path d="M60 66 Q70 50 84 54 Q98 44 112 52 Q130 44 148 52 Q164 46 176 54 Q192 50 200 66 Z" fill="var(--surface-soft)" stroke="var(--border)" stroke-width="1"/>

      <g class="szone" data-p="hydration" tabindex="0" role="button" aria-label="Poche à eau interne">
        <rect class="zfill" x="50" y="92" width="14" height="150" rx="5" fill="var(--glacier)" opacity=".3"/>
        <rect class="zstroke" x="50" y="92" width="14" height="150" rx="5"/>
        <text x="57" y="170" class="zcount" text-anchor="middle" transform="rotate(-90 57 170)">${c('hydration')}</text>
        <g class="sblaze" transform="translate(50,246)"><rect width="9" height="14" fill="#fff"/><rect width="9" height="4" fill="#d63b2c"/><rect y="10" width="9" height="4" fill="#d63b2c"/></g>
      </g>
      <g class="szone" data-p="main" tabindex="0" role="button" aria-label="Compartiment principal">
        <rect class="zfill" x="68" y="92" width="140" height="150" rx="6" fill="var(--glacier)" opacity=".13"/>
        <rect class="zstroke" x="68" y="92" width="140" height="150" rx="6"/>
        <text x="138" y="158" class="zlabel" text-anchor="middle">Compartiment principal</text>
        <text x="138" y="170" class="zlabel" text-anchor="middle" style="font-size:6px">chargement par le haut</text>
        <text x="138" y="186" class="zcount" text-anchor="middle">${c('main')}</text>
        <g class="sblaze" transform="translate(196,98)"><rect width="9" height="14" fill="#fff"/><rect width="9" height="4" fill="#d63b2c"/><rect y="10" width="9" height="4" fill="#d63b2c"/></g>
      </g>
      <line x1="47" y1="286" x2="213" y2="286" stroke="var(--border)" stroke-width="1.6" stroke-dasharray="3 3"/>
      <g class="szone" data-p="bottom" tabindex="0" role="button" aria-label="Compartiment bas zippé">
        <rect class="zfill" x="50" y="290" width="156" height="100" rx="7" fill="var(--pine)" opacity=".2"/>
        <rect class="zstroke" x="50" y="290" width="156" height="100" rx="7"/>
        <text x="128" y="330" class="zlabel" text-anchor="middle">Compartiment bas</text>
        <text x="128" y="341" class="zlabel" text-anchor="middle" style="font-size:6px">duvet · matelas · nuit</text>
        <text x="128" y="357" class="zcount" text-anchor="middle">${c('bottom')}</text>
        <g class="sblaze" transform="translate(194,296)"><rect width="9" height="14" fill="#fff"/><rect width="9" height="4" fill="#d63b2c"/><rect y="10" width="9" height="4" fill="#d63b2c"/></g>
      </g>
      <path d="M52 288 L204 288" stroke="var(--ink)" stroke-width="2.2" opacity=".5"/>
      <circle cx="128" cy="288" r="3.4" fill="var(--glacier)"/>
      <g class="szone" data-p="front" tabindex="0" role="button" aria-label="Grande poche frontale">
        <path class="zfill" d="M74 210 Q74 204 80 204 L196 204 Q202 204 202 210 L202 300 Q202 306 196 306 L80 306 Q74 306 74 300 Z" fill="var(--gold)" opacity=".18"/>
        <path class="zstroke" d="M74 210 Q74 204 80 204 L196 204 Q202 204 202 210 L202 300 Q202 306 196 306 L80 306 Q74 306 74 300 Z"/>
        <text x="138" y="258" class="zlabel" text-anchor="middle">Poche frontale</text>
        <text x="138" y="269" class="zlabel" text-anchor="middle" style="font-size:6px">accès rapide · imper</text>
        <text x="138" y="285" class="zcount" text-anchor="middle">${c('front')}</text>
        <g class="sblaze" transform="translate(188,210)"><rect width="9" height="14" fill="#fff"/><rect width="9" height="4" fill="#d63b2c"/><rect y="10" width="9" height="4" fill="#d63b2c"/></g>
      </g>
      <g class="szone" data-p="lid_top" tabindex="0" role="button" aria-label="Poche supérieure du rabat">
        <path class="zfill" d="M52 60 Q52 30 84 26 L172 26 Q204 30 204 60 L204 74 L52 74 Z" fill="var(--rust)" opacity=".26"/>
        <path class="zstroke" d="M52 60 Q52 30 84 26 L172 26 Q204 30 204 60 L204 74 L52 74 Z"/>
        <text x="128" y="46" class="zlabel" text-anchor="middle">Poche du rabat</text>
        <text x="128" y="57" class="zlabel" text-anchor="middle" style="font-size:6px">dessus · accès marche</text>
        <text x="128" y="68" class="zcount" text-anchor="middle">${c('lid_top')}</text>
        <g class="sblaze" transform="translate(190,30)"><rect width="9" height="14" fill="#fff"/><rect width="9" height="4" fill="#d63b2c"/><rect y="10" width="9" height="4" fill="#d63b2c"/></g>
      </g>
      <path d="M62 70 Q128 62 194 70" stroke="var(--ink)" stroke-width="2" fill="none" opacity=".5"/>
      <g class="szone" data-p="lid_under" tabindex="0" role="button" aria-label="Poche intérieure du rabat">
        <rect class="zfill" x="92" y="78" width="72" height="16" rx="4" fill="var(--glacier)" opacity=".24"/>
        <rect class="zstroke" x="92" y="78" width="72" height="16" rx="4"/>
        <text x="128" y="89" class="zcount" text-anchor="middle">${c('lid_under')}</text>
        <g class="sblaze" transform="translate(150,79)"><rect width="8" height="13" fill="#fff"/><rect width="8" height="3.5" fill="#d63b2c"/><rect y="9.5" width="8" height="3.5" fill="#d63b2c"/></g>
      </g>
      <text x="128" y="102" class="zcount" text-anchor="middle" opacity=".45" style="font-size:6.5px">POCHE SÉCURITÉ (SOUS LE RABAT)</text>
      <g class="szone" data-p="mesh_left" tabindex="0" role="button" aria-label="Filet latéral gauche">
        <path class="zfill" d="M30 250 Q22 250 22 262 L22 330 Q22 344 34 346 L44 348 L44 250 Z" fill="var(--glacier)" opacity=".22"/>
        <path class="zstroke" d="M30 250 Q22 250 22 262 L22 330 Q22 344 34 346 L44 348 L44 250 Z"/>
        <text x="33" y="300" class="zcount" text-anchor="middle" transform="rotate(-90 33 300)">${c('mesh_left')}</text>
        <g class="sblaze" transform="translate(24,254)"><rect width="8" height="12" fill="#fff"/><rect width="8" height="3.2" fill="#d63b2c"/><rect y="8.8" width="8" height="3.2" fill="#d63b2c"/></g>
      </g>
      <g class="szone" data-p="mesh_right" tabindex="0" role="button" aria-label="Filet latéral droit">
        <path class="zfill" d="M230 250 Q238 250 238 262 L238 330 Q238 344 226 346 L216 348 L216 250 Z" fill="var(--glacier)" opacity=".22"/>
        <path class="zstroke" d="M230 250 Q238 250 238 262 L238 330 Q238 344 226 346 L216 348 L216 250 Z"/>
        <text x="227" y="300" class="zcount" text-anchor="middle" transform="rotate(90 227 300)">${c('mesh_right')}</text>
        <g class="sblaze" transform="translate(228,254)"><rect width="8" height="12" fill="#fff"/><rect width="8" height="3.2" fill="#d63b2c"/><rect y="8.8" width="8" height="3.2" fill="#d63b2c"/></g>
      </g>
      <g class="szone" data-p="straps" tabindex="0" role="button" aria-label="Sangles de compression et porte-bâtons">
        <rect class="zfill" x="70" y="112" width="136" height="9" fill="var(--rust)" opacity=".16"/>
        <rect class="zfill" x="70" y="168" width="136" height="9" fill="var(--rust)" opacity=".16"/>
        <rect class="zstroke" x="66" y="108" width="144" height="76" rx="4"/>
        <g class="sblaze" transform="translate(70,150)"><rect width="8" height="12" fill="#fff"/><rect width="8" height="3.2" fill="#d63b2c"/><rect y="8.8" width="8" height="3.2" fill="#d63b2c"/></g>
      </g>
      <rect x="66" y="114" width="144" height="4" rx="2" fill="var(--ink)" opacity=".4"/>
      <rect x="66" y="170" width="144" height="4" rx="2" fill="var(--ink)" opacity=".4"/>
      <text x="138" y="200" class="zcount" text-anchor="middle" opacity=".5" style="font-size:6.5px">SANGLES · PORTE-BÂTONS · ${c('straps')}</text>
      <g class="szone" data-p="hipbelt" tabindex="0" role="button" aria-label="Ceinture lombaire">
        <path class="zfill" d="M40 372 Q30 372 26 384 L20 402 L70 402 L74 372 Z" fill="var(--gold)" opacity=".24"/>
        <path class="zfill" d="M220 372 Q230 372 234 384 L240 402 L190 402 L186 372 Z" fill="var(--gold)" opacity=".24"/>
        <path class="zstroke" d="M40 372 Q30 372 26 384 L20 402 L70 402 L74 372 Z"/>
        <path class="zstroke" d="M220 372 Q230 372 234 384 L240 402 L190 402 L186 372 Z"/>
        <text x="45" y="392" class="zcount" text-anchor="middle">${c('hipbelt')}</text>
        <g class="sblaze" transform="translate(24,382)"><rect width="8" height="12" fill="#fff"/><rect width="8" height="3.2" fill="#d63b2c"/><rect y="8.8" width="8" height="3.2" fill="#d63b2c"/></g>
      </g>
      <text x="128" y="392" class="zlabel" text-anchor="middle" opacity=".7">Ceinture</text>
      <text x="138" y="230" text-anchor="middle" style="font-family:Georgia,serif;font-size:11px;letter-spacing:.12em;fill:var(--glacier);opacity:.6;font-weight:700">KHUMBU 65+10</text>
    </svg>`;
  }

  function sacTips(pid){
    const here = sacPack.filter(i=>i.pocket===pid);
    const meta = i => SAC_META[i.name]||{};
    const tips=[]; const add=(t,a=false)=>tips.push({t,a});
    if(pid==='main'){
      add('Le lourd contre le dos, à mi-hauteur — c\'est le cœur de l\'équilibre.');
      add('Idéal ici : nourriture, réchaud, popote, toile de tente.');
      if(here.some(i=>meta(i).sep_food) && here.some(i=>meta(i).cat==='Alimentation'))
        add('Cartouche de gaz ET nourriture dans la même poche : sépare le gaz des aliments (goût, sécurité).',true);
    } else if(pid==='lid_top'){
      add('Poche en marche : petits objets à accès fréquent uniquement.');
      const h=here.filter(i=>meta(i).lourd);
      if(h.length) add(`${h.map(i=>i.name).join(', ')} : trop lourd ici, ça remonte le centre de gravité → descends-le dans le compartiment principal.`,true);
    } else if(pid==='lid_under'){
      add('Poche sécurité, contre la tête : regroupe papiers, cash, cartes, réservations.');
      const pe=sacPack.filter(i=>meta(i).cat==='Papiers & navigation' && i.pocket!=='lid_under' && (SAC_META[i.name]?.ideal||[]).includes('lid_under'));
      if(pe.length) add(`Des papiers sont ailleurs (${pe.map(i=>i.name).join(', ')}) : regroupe-les ici.`);
    } else if(pid==='front'){
      add('Couche imperméable ici : veste + surpantalon + housse de pluie, accessibles aux cols.');
      add('Garde le mouillé loin du sec — cette poche plate isole bien.');
    } else if(pid==='bottom'){
      add('Volumineux et léger : sac de couchage, matelas, affaires de nuit.');
      const h=here.filter(i=>meta(i).lourd);
      if(h.length) add(`${h.map(i=>i.name).join(', ')} en bas : ça déséquilibre vers le bas → remonte-le dans le compartiment principal.`,true);
    } else if(pid==='hydration'){
      add('2 L d\'eau = 2 kg parfaitement placés, plaqués contre le dos et centrés.');
      add('Passe le tuyau par-dessus l\'épaule avant de fermer.');
    } else if(pid==='mesh_left'||pid==='mesh_right'){
      add('À portée de main sans enlever le sac : gourde, en-cas.');
      const wl=sacPack.filter(i=>i.pocket==='mesh_left').reduce((s,i)=>s+(+i.g||0),0);
      const wr=sacPack.filter(i=>i.pocket==='mesh_right').reduce((s,i)=>s+(+i.g||0),0);
      if(Math.abs(wl-wr)>300) add(`Déséquilibre gauche/droite : ${(wl/1000).toFixed(1)} kg vs ${(wr/1000).toFixed(1)} kg. Mets une gourde de chaque côté.`,true);
      else add('Équilibre gauche/droite correct.');
    } else if(pid==='straps'){
      add('Bâtons de marche + tapis de sol sur les sangles de compression.');
      add('Rien qui pende : ça s\'accroche dans les passages câblés et les échelles.');
    } else if(pid==='hipbelt'){
      add('Petits objets d\'accès immédiat : barres, stick à lèvres, sifflet.');
      if(!here.length) add('Si ta ceinture n\'a pas de poches, serre-la en premier : elle porte 80 % de la charge.');
    }
    return tips.slice(0,4);
  }

  function renderSacLoad(){
    const tot=sacPack.reduce((s,i)=>s+(+i.g||0),0), kg=tot/1000;
    const unw=sacPack.filter(i=>!i.g).length;
    let cls='',msg='',mc='';
    if(kg>15){cls='over';msg='Reprends la liste, enlève quelque chose. Au-dessus de 15 kg, chaque montée se paie.';mc='over';}
    else if(kg>=12&&kg<=14){msg='Fenêtre idéale : 12–14 kg. Le sac est réglé pour le TMB.';mc='ok';}
    else if(kg>14&&kg<=15){cls='warn';msg='Encore acceptable, mais tu frôles la limite haute.';mc='ok';}
    let up=0,dn=0,lf=0,rt=0;
    for(const i of sacPack){const p=PMAP[i.pocket];if(!p)continue;const g=+i.g||0;
      if(p.vpos==='haut')up+=g;else dn+=g; if(p.side==='gauche')lf+=g;else if(p.side==='droite')rt+=g;}
    const ud=up+dn||1, lr=lf+rt||1, pct=(a,t)=>Math.round(a/t*100);
    $('#sacLoad').innerHTML=`
      <div class="load-top"><div class="load-kg ${cls}">${kg.toFixed(2)}<small>kg</small></div>
      <div class="load-goal">objectif<br><b>12–14 kg</b></div></div>
      ${msg?`<div class="load-msg ${mc}">${msg}</div>`:''}
      <div class="balances">
        <div><div class="bal-head"><span>Haut ${(up/1000).toFixed(1)} kg</span><span>Bas ${(dn/1000).toFixed(1)} kg</span></div>
        <div class="bal-bar"><span class="bal-a" style="width:${pct(up,ud)}%"></span><span class="bal-b" style="width:${pct(dn,ud)}%"></span></div></div>
        <div><div class="bal-head"><span>Gauche ${(lf/1000).toFixed(1)} kg</span><span>Droite ${(rt/1000).toFixed(1)} kg</span></div>
        <div class="bal-bar"><span class="bal-a" style="width:${pct(lf,lr)}%"></span><span class="bal-b" style="width:${pct(rt,lr)}%"></span></div></div>
      </div>
      ${unw?`<div class="load-unweighed"><b>${unw}</b> objet${unw>1?'s':''} sans poids saisi</div>`:''}`;
  }

  function renderSacCatalogue(){
    const inP=new Set(sacPack.filter(i=>i.pocket===sacSel).map(i=>i.name));
    const cats=Object.entries(SAC_CATALOGUE).map(([cat,arr])=>{
      const opts=arr.map(o=>{
        const ck=inP.has(o.n), isI=(o.ideal||[]).includes(sacSel);
        const idn=(o.ideal||[]).map(z=>PMAP[z]?.name||z).join(', ');
        return `<label class="opt ${ck?'here':''}"><input type="checkbox" data-opt="${escSac(o.n)}" ${ck?'checked':''}>
          <span class="o-nm">${escSac(o.n)}${o.lourd?' <span class="opt-heavy">◆ lourd</span>':''}</span>
          <span class="o-g">${o.g} g</span>
          ${isI?'<span class="o-ideal">idéal ici</span>':`<span class="o-ideal" style="color:var(--text-soft);border-color:var(--border)" title="Idéal : ${escSac(idn)}">${escSac(PMAP[o.ideal[0]]?.name||'')}</span>`}</label>`;
      }).join('');
      const nH=arr.filter(o=>inP.has(o.n)).length;
      return `<details class="cat" data-cat="${escSac(cat)}"><summary>${escSac(cat)} ${nH?`<span class="cat-count">${nH} ici</span>`:''}</summary><div class="cat-body">${opts}</div></details>`;
    }).join('');
    return `<div class="catalogue">${cats}</div>`;
  }

  function renderSacPanel(){
    const panel=$('#sacPanel');
    if(!sacSel){ panel.innerHTML=`<div class="pocket-none">Choisis une poche sur le schéma.<br><b>Chaque poche a un rôle</b> — l\'app te propose quoi y ranger et repère ce qui est mal placé.</div>`; return; }
    const p=PMAP[sacSel], here=sacPack.filter(i=>i.pocket===sacSel), tips=sacTips(sacSel);
    const tipsH=tips.map(t=>`<div class="tip ${t.a?'alert':''}"><span class="tip-ico">${t.a?'!':'›'}</span><span>${escSac(t.t)}</span></div>`).join('');
    const itemsH=here.length?`<div class="pk-items">${here.map(i=>{
      const m=SAC_META[i.name]||{}, mis=m.ideal&&!m.ideal.includes(sacSel);
      const idn=(m.ideal||[]).map(z=>PMAP[z]?.name||z).join(', ');
      return `<div class="pk-item"><span class="pk-nm">${escSac(i.name)}${m.lourd?'<span class="pk-heavy">lourd</span>':''}</span>
        ${mis?`<button class="pk-advice" data-advise="${i.id}" title="Idéal : ${escSac(idn)}">→ ${escSac(PMAP[m.ideal[0]].name)}</button>`:''}
        <input class="pk-wt" type="number" min="0" step="10" value="${i.g||0}" data-wt="${i.id}" aria-label="Poids"> <span style="font-family:ui-monospace,monospace;font-size:.65rem;color:var(--text-soft)">g</span>
        <button class="pk-move" data-move="${i.id}" title="Déplacer">⇄</button>
        <button class="pk-del" data-del="${i.id}" aria-label="Retirer">✕</button></div>`;
    }).join('')}</div>`:`<div class="pocket-none" style="padding:18px">Cette poche est vide.</div>`;
    panel.innerHTML=`<div class="pocket-head"><h3>${escSac(p.name)}</h3><span style="font-family:ui-monospace,monospace;font-size:.72rem;color:var(--gold)">${here.length} objet${here.length>1?'s':''}</span></div>
      <p class="pocket-role">${escSac(p.role)}</p><div class="tips">${tipsH}</div>${itemsH}
      <button class="btn addbtn ${sacAddOpen?'':'btn-primary'}" id="sacToggleAdd">${sacAddOpen?'Fermer le catalogue':'Ajouter des objets'}</button>
      ${sacAddOpen?renderSacCatalogue():''}`;
  }

  function sacCounts(){ const c={}; for(const i of sacPack) c[i.pocket]=(c[i.pocket]||0)+1; return c; }
  function applySacHighlight(){
    let hit=new Set();
    if(sacHoverCat&&SAC_CATALOGUE[sacHoverCat]){ const names=new Set(SAC_CATALOGUE[sacHoverCat].map(o=>o.n)); hit=new Set(sacPack.filter(i=>names.has(i.name)).map(i=>i.pocket)); }
    $all('#sacPackwrap .szone').forEach(g=>g.classList.toggle('hit',hit.has(g.dataset.p)));
  }
  function renderSacVisuel(){
    $('#sacPackwrap').innerHTML=sacSVG(sacCounts());
    $all('#sacPackwrap .szone').forEach(g=>g.classList.toggle('sel',sacSel===g.dataset.p));
    applySacHighlight(); renderSacLoad(); renderSacPanel();
    const tot=sacPack.reduce((s,i)=>s+(+i.g||0),0);
    $('#sacTot').textContent=sacPack.length?`${sacPack.length} objet${sacPack.length>1?'s':''} rangé${sacPack.length>1?'s':''} · ${(tot/1000).toFixed(2)} kg`:'Sac vide';
  }

  /* ── Sous-onglet Liste rapide ── */
  function sacListMatches(it){ if(!sacListQuery) return false; const q=normSac(sacListQuery);
    return normSac(it.name).includes(q)||normSac(PMAP[it.zone]?.name||'').includes(q); }
  function renderSacList(){
    const counts={}; for(const i of sacListItems) counts[i.zone]=(counts[i.zone]||0)+1;
    $('#listPackwrap').innerHTML=sacSVG(counts);
    const hit=new Set(sacListItems.filter(sacListMatches).map(i=>i.zone));
    $all('#listPackwrap .szone').forEach(g=>{ g.classList.toggle('hit',hit.has(g.dataset.p)); g.classList.toggle('sel',sacListFilter===g.dataset.p); });
    $('#listChips').innerHTML=LIST_ZONES.map(z=>{ const n=sacListItems.filter(i=>i.zone===z.id).length;
      return `<button class="sac-chip ${sacListFilter===z.id?'sel':''} ${hit.has(z.id)?'hit':''}" data-lz="${z.id}">${escSac(z.label)}${n?`<b>${n}</b>`:''}</button>`; }).join('');
    let shown=sacListItems.slice().sort((a,b)=>a.name.localeCompare(b.name,'fr'));
    if(sacListFilter) shown=shown.filter(i=>i.zone===sacListFilter);
    if(sacListQuery) shown=shown.filter(sacListMatches);
    $('#listTitle').textContent=sacListFilter?PMAP[sacListFilter].name:sacListQuery?`Résultats pour « ${sacListQuery} »`:'Contenu du sac';
    if(!sacListItems.length) $('#listItems').innerHTML=`<div class="sac-empty">La liste est vide.<br><b>Commence par le lourd</b> — nourriture, réchaud, eau.</div>`;
    else if(!shown.length) $('#listItems').innerHTML=`<div class="sac-empty">${sacListQuery?`Rien qui corresponde à « ${sacListQuery} ».`:'Cette zone est vide.'}</div>`;
    else $('#listItems').innerHTML=shown.map(i=>`<div class="sac-litem ${sacListMatches(i)?'hit':''}"><span class="li-nm">${escSac(i.name)}</span><span class="li-zn">${escSac(PMAP[i.zone].name)}</span><span class="li-wt">${i.g?i.g+' g':''}</span><button class="li-del" data-ldel="${i.id}" aria-label="Retirer">✕</button></div>`).join('');
    const tot=sacListItems.reduce((s,i)=>s+(+i.g||0),0), p=sacListItems.filter(i=>i.g).length;
    $('#listTot').innerHTML=sacListItems.length?`${sacListItems.length} objet${sacListItems.length>1?'s':''} · ${(tot/1000).toFixed(2)} kg${p<sacListItems.length?` (${sacListItems.length-p} sans poids)`:''}`:'';
    $('#sacClr').hidden=!sacListQuery;
  }

  function renderSac(){
    if(!sacInited){
      $('#listZn').innerHTML=LIST_ZONES.map(z=>`<option value="${z.id}">${escSac(z.label)}</option>`).join('');
      sacInited=true;
    }
    renderSacVisuel(); renderSacList();
  }

  function bindSacEvents(){
    // sous-onglets
    document.addEventListener('click', e=>{
      const st=e.target.closest('[data-subtab]'); if(!st) return;
      const name=st.dataset.subtab;
      $all('.subtab').forEach(b=>{ const on=b.dataset.subtab===name; b.classList.toggle('is-active',on); b.setAttribute('aria-selected',String(on)); });
      $all('.sac-subview').forEach(v=>v.classList.toggle('is-active',v.dataset.subview===name));
    });
    // clic poche schéma (visuel)
    document.addEventListener('click', e=>{
      const z=e.target.closest('#sacPackwrap .szone'); if(!z) return;
      sacSel=(sacSel===z.dataset.p)?null:z.dataset.p; sacAddOpen=false; renderSacVisuel();
    });
    document.addEventListener('keydown', e=>{
      const z=e.target.closest('#sacPackwrap .szone'); if(z&&(e.key==='Enter'||e.key===' ')){ e.preventDefault(); sacSel=(sacSel===z.dataset.p)?null:z.dataset.p; sacAddOpen=false; renderSacVisuel(); }
    });
    // panneau poche : toggle add, del, advise, move
    document.addEventListener('click', e=>{
      if(!$('[data-panel="sac"]')?.classList.contains('is-active')) return;
      if(e.target.closest('#sacToggleAdd')){ sacAddOpen=!sacAddOpen; renderSacPanel(); return; }
      const del=e.target.closest('[data-del]'); if(del){ sacPack=sacPack.filter(i=>i.id!==del.dataset.del); saveSacPack(); renderSacVisuel(); return; }
      const adv=e.target.closest('[data-advise]'); if(adv){ const it=sacPack.find(i=>i.id===adv.dataset.advise); if(it){const m=SAC_META[it.name]; if(m&&m.ideal){it.pocket=m.ideal[0]; saveSacPack(); sacSel=m.ideal[0]; renderSacVisuel();}} return; }
      const mv=e.target.closest('[data-move]'); if(mv){ const it=sacPack.find(i=>i.id===mv.dataset.move); if(!it)return;
        const opts=POCKETS.map((p,i)=>`${i+1}. ${p.name}`).join('\n');
        const ans=prompt(`Déplacer « ${it.name} » vers quelle poche ?\n\n${opts}\n\nEntre un numéro (1–10) :`);
        const idx=parseInt(ans,10); if(idx>=1&&idx<=POCKETS.length){ it.pocket=POCKETS[idx-1].id; saveSacPack(); renderSacVisuel(); } return; }
    });
    // cocher catalogue + éditer poids
    document.addEventListener('change', e=>{
      const cb=e.target.closest('[data-opt]');
      if(cb&&sacSel){ const name=cb.dataset.opt;
        if(cb.checked){ const m=SAC_META[name]; sacPack.push({id:'p'+Date.now()+Math.random().toString(36).slice(2,6),name,pocket:sacSel,g:m?m.g:0}); }
        else{ const i=sacPack.findIndex(x=>x.name===name&&x.pocket===sacSel); if(i>=0) sacPack.splice(i,1); }
        saveSacPack(); renderSacVisuel(); return; }
      const wt=e.target.closest('[data-wt]');
      if(wt){ const it=sacPack.find(i=>i.id===wt.dataset.wt); if(it){ it.g=+wt.value||0; saveSacPack(); renderSacLoad();
        const tot=sacPack.reduce((s,i)=>s+(+i.g||0),0); $('#sacTot').textContent=`${sacPack.length} objet${sacPack.length>1?'s':''} rangé${sacPack.length>1?'s':''} · ${(tot/1000).toFixed(2)} kg`; } return; }
    });
    // survol catégories -> highlight balise GR
    document.addEventListener('mouseover', e=>{ const c=e.target.closest('.cat'); if(c){ sacHoverCat=c.dataset.cat; applySacHighlight(); } });
    document.addEventListener('mouseout', e=>{ const c=e.target.closest('.cat'); if(c&&!c.contains(e.relatedTarget)){ sacHoverCat=null; applySacHighlight(); } });
    // reset pack
    $('#sacReset').addEventListener('click',()=>{ if(!sacPack.length)return; if(confirm('Vider le sac ? Le contenu rangé par poche sera perdu.')){ sacPack=[]; sacSel=null; sacAddOpen=false; saveSacPack(); renderSacVisuel(); } });

    // ── Liste rapide ──
    $('#listAdd').addEventListener('click',()=>{ const name=$('#listNm').value.trim(); if(!name){$('#listNm').focus();return;}
      sacListItems.push({id:'l'+Date.now(),name,zone:$('#listZn').value,g:+$('#listWt').value||0}); $('#listNm').value='';$('#listWt').value='';$('#listNm').focus(); saveSacList(); renderSacList(); });
    $('#listNm').addEventListener('keydown',e=>{ if(e.key==='Enter')$('#listAdd').click(); });
    $('#listWt').addEventListener('keydown',e=>{ if(e.key==='Enter')$('#listAdd').click(); });
    $('#sacQ').addEventListener('input',e=>{ sacListQuery=e.target.value.trim(); renderSacList(); });
    $('#sacClr').addEventListener('click',()=>{ sacListQuery=''; $('#sacQ').value=''; renderSacList(); });
    document.addEventListener('click', e=>{
      const li=e.target.closest('[data-ldel]'); if(li){ sacListItems=sacListItems.filter(i=>i.id!==li.dataset.ldel); saveSacList(); renderSacList(); return; }
      const lz=e.target.closest('[data-lz]'); if(lz){ sacListFilter=(sacListFilter===lz.dataset.lz)?null:lz.dataset.lz; renderSacList(); return; }
      const lzone=e.target.closest('#listPackwrap .szone'); if(lzone){ sacListFilter=(sacListFilter===lzone.dataset.p)?null:lzone.dataset.p; renderSacList(); return; }
    });
    $('#listReset').addEventListener('click',()=>{ if(!sacListItems.length)return; if(confirm('Vider la liste ?')){ sacListItems=[]; sacListFilter=null; saveSacList(); renderSacList(); } });
  }

  function init(){
    initDarkMode(); renderHero(); renderDashboard();
    fetchHeroWeather(); renderPrep(); renderTrekCard(); renderStages(); renderBudget(); renderChecklist(); renderMapButtons(); bindEvents(); loadSacData(); bindSacEvents();
    if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  }
  init();
})();
