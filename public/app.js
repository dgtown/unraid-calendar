/* global FullCalendar */
(function () {
  const $ = s => document.querySelector(s);
  const dlg = $('#event-dialog');
  const form = $('#event-form');
  let editingId = null;
  let editingOcc = null; // start (ms) of the clicked occurrence of a repeating event

  function toast(msg, ms = 3500) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  // ---- date helpers for <input type=datetime-local / date> ----
  const pad = n => String(n).padStart(2, '0');
  const localDT = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const localD = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function setAllDayInputs(allDay) {
    for (const name of ['start', 'end']) {
      const el = form.elements[name];
      const v = el.value;
      el.type = allDay ? 'date' : 'datetime-local';
      if (v) el.value = allDay ? v.slice(0, 10) : (v.length === 10 ? `${v}T09:00` : v);
    }
  }
  form.elements.allDay.addEventListener('change', e => setAllDayInputs(e.target.checked));

  function openEditor(ev) {
    editingId = ev && ev.id ? ev.id : null;
    editingOcc = ev?.extendedProps?.repeat ? ev.extendedProps.occurrence : null;
    $('#event-dialog-title').textContent = editingId ? 'Edit event' : 'New event';
    $('#delete-btn').hidden = !editingId;
    form.reset();
    const allDay = Boolean(ev && ev.allDay);
    form.elements.title.value = ev?.extendedProps?.plainTitle || ev?.title || '';
    form.elements.allDay.checked = allDay;
    form.elements.start.type = form.elements.end.type = allDay ? 'date' : 'datetime-local';
    const start = ev?.start || new Date(Math.ceil(Date.now() / 3600000) * 3600000);
    let end = ev?.end || new Date(start.getTime() + 3600000);
    if (allDay) {
      // Inclusive end date in the editor; exclusive in storage.
      end = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
      form.elements.start.value = localD(start);
      form.elements.end.value = localD(end < start ? start : end);
    } else {
      form.elements.start.value = localDT(start);
      form.elements.end.value = localDT(end);
    }
    form.elements.repeat.value = ev?.extendedProps?.repeat || '';
    const note = $('#repeat-note');
    note.hidden = !editingOcc;
    note.textContent = editingOcc ? `Repeats ${ev.extendedProps.repeatText}. Changes here apply to all of them.` : '';
    form.elements.location.value = ev?.extendedProps?.location || '';
    form.elements.notes.value = ev?.extendedProps?.notes || '';
    const r = ev?.extendedProps?.reminderMin;
    form.elements.reminderMin.value = r == null ? '' : String(r);
    if (r != null && form.elements.reminderMin.value !== String(r)) {
      form.elements.reminderMin.add(new Option(`${r} min before`, String(r)));
      form.elements.reminderMin.value = String(r);
    }
    dlg.showModal();
    if (!editingId) form.elements.title.focus();
  }

  function readForm() {
    const f = form.elements;
    const allDay = f.allDay.checked;
    let start, end;
    if (allDay) {
      start = f.start.value;
      const last = f.end.value || f.start.value;
      const d = new Date(`${last}T00:00`);
      end = localD(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
    } else {
      start = new Date(f.start.value).toISOString();
      end = f.end.value ? new Date(f.end.value).toISOString() : null;
    }
    return {
      title: f.title.value.trim(), allDay, start, end, location: f.location.value.trim() || null,
      notes: f.notes.value.trim() || null, reminderMin: f.reminderMin.value === '' ? null : Number(f.reminderMin.value),
      repeat: f.repeat.value || null, occurrence: editingOcc,
    };
  }

  form.addEventListener('submit', async e => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    try {
      const body = readForm();
      if (editingId) await api('PUT', `api/events/${editingId}`, body);
      else await api('POST', 'api/events', body);
      dlg.close();
      calendar.refetchEvents();
    } catch (err) { toast(err.message); }
  });

  $('#delete-btn').addEventListener('click', async () => {
    if (!editingId) return;
    let url = `api/events/${editingId}`;
    if (editingOcc != null) {
      if (confirm('Delete just this one? (Cancel to choose deleting all of them)')) url += `?occurrence=${editingOcc}`;
      else if (!confirm('Delete every one of these repeating events?')) return;
    } else if (!confirm('Delete this event?')) return;
    try { await api('DELETE', url); dlg.close(); calendar.refetchEvents(); } catch (err) { toast(err.message); }
  });

  $('#new-btn').addEventListener('click', () => openEditor(null));

  $('#quick').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('#quick-text');
    const text = input.value.trim();
    if (!text) return;
    try {
      const r = await api('POST', 'api/quick-add', { text });
      input.value = '';
      toast(`Added: ${r.summary}`);
      calendar.refetchEvents();
      calendar.gotoDate(r.event.start);
    } catch (err) { toast(err.message, 5000); }
  });

  // ---- status dialog ----
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  $('#settings-btn').addEventListener('click', async () => {
    const body = $('#status-body');
    body.textContent = 'Loading…';
    $('#status-dialog').showModal();
    try {
      const s = await api('GET', 'api/status');
      const when = t => t ? new Date(t).toLocaleString() : 'never';
      body.innerHTML = `
        <p><b>Time zone:</b> ${esc(s.timezone)}</p>
        <p><b>Text messages:</b> ${s.sms.enabled
          ? `on, number ${esc(s.sms.did)}, ${s.sms.allowed} allowed sender(s). Last check: ${esc(when(s.sms.lastPoll))}${s.sms.lastError ? ` <br><b style="color:var(--danger)">Error:</b> ${esc(s.sms.lastError)}` : ''}`
          : 'off (set the VOIPMS_* settings in the container)'}</p>
        <p><b>Morning agenda text:</b> ${s.dailyAgenda === 'off' ? 'off (text DAILY 7am to turn on)' : `every day at ${esc(s.dailyAgenda)} (text DAILY OFF to stop)`}</p>
        <p><b>Phone subscription feed:</b> ${s.feed
          ? `<code>${esc(new URL('calendar.ics', location.href).href.split('?')[0])}?token=YOUR_FEED_TOKEN</code>`
          : 'off (set FEED_TOKEN in the container)'}</p>
        <p><b>Backups:</b> ${s.backups.length ? `${s.backups.length} nightly copies in appdata/backups, newest ${esc(s.backups[s.backups.length - 1])}` : 'none yet'}</p>
        <p><b>Recent texts</b></p>
        <div class="sms-log">${s.recentSms.length ? s.recentSms.map(m =>
          `<div>${m.direction === 'in' ? '⬅' : '➡'} ${esc(new Date(m.at).toLocaleString())} · ${esc(m.number)}<br>${esc(m.body)}</div>`).join('')
          : 'None yet.'}</div>`;
    } catch (err) { body.textContent = err.message; }
  });

  // ---- calendar ----
  const narrow = window.matchMedia('(max-width: 640px)').matches;
  const calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
    initialView: narrow ? 'listWeek' : 'dayGridMonth',
    headerToolbar: narrow
      ? { left: 'prev,next today', center: '', right: 'title' }
      : { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' },
    footerToolbar: narrow ? { center: 'dayGridMonth,timeGridDay,listWeek' } : undefined,
    buttonText: { today: 'Today', month: 'Month', week: 'Week', day: 'Day', list: 'Agenda' },
    height: '100%',
    nowIndicator: true,
    editable: true,
    selectable: true,
    dayMaxEvents: true,
    events: 'api/events',
    eventDataTransform: e => ({
      ...e, title: e.repeat ? `↻ ${e.title}` : e.title, editable: !e.repeat, // drag/resize only for one-off events
      extendedProps: { location: e.location, notes: e.notes, reminderMin: e.reminderMin, repeat: e.repeat,
        repeatText: e.repeatText, occurrence: e.occurrence, plainTitle: e.title },
    }),
    eventClick: info => { info.jsEvent.preventDefault(); openEditor(info.event); },
    select: info => {
      calendar.unselect();
      openEditor({ start: info.start, end: info.end, allDay: info.allDay });
    },
    eventDrop: info => save(info),
    eventResize: info => save(info),
  });

  async function save(info) {
    const e = info.event;
    const allDay = e.allDay;
    const end = e.end || new Date(e.start.getTime() + (allDay ? 86400000 : 3600000));
    try {
      await api('PUT', `api/events/${e.id}`, {
        allDay,
        start: allDay ? localD(e.start) : e.start.toISOString(),
        end: allDay ? localD(end) : end.toISOString(),
      });
    } catch (err) { toast(err.message); info.revert(); }
  }

  calendar.render();
  // Pick up texts that arrive while the page is open.
  setInterval(() => { if (!document.hidden && !dlg.open) calendar.refetchEvents(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) calendar.refetchEvents(); });
})();
