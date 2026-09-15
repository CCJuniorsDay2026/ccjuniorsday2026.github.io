/**
 * Protocol 16 – gemeinsame Supabase-Anbindung für alle Spielseiten.
 * Ersetzt die bisherigen einzelnen fetch(API_URL, ...)-Aufrufe gegen Apps Script.
 *
 * Eingebunden wird das so (Reihenfolge wichtig):
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
 *   <script src="mission-common.js"></script>
 *
 * Auf jeder Spielseite reicht dann:
 *   Mission.initPage('13');           // beim Laden: Fortschritt "open" + Hilfe-Button verdrahten
 *   Mission.markDone('13');           // wenn die Aufgabe gelöst ist, vor dem Seitenwechsel
 */
(function (global) {
  var SUPABASE_URL = 'https://heqdrhhfxuukxacehymk.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhlcWRyaGhmeHV1a3hhY2VoeW1rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0ODY0MjMsImV4cCI6MjEwNTA2MjQyM30.o2MxDF4stp5BfFtpWRRZgzPBE-9SKIYgM9KlqSBz_fM';

  var client = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var RPC_URL = SUPABASE_URL + '/rest/v1/rpc/';

  function team() {
    return sessionStorage.getItem('teamNumber');
  }

  // Zuverlässiger "Fire and forget"-Aufruf, auch wenn direkt danach die Seite
  // verlassen wird (Ersatz für fetch(..., { keepalive: true })).
  function rpcKeepalive(fn, params) {
    try {
      fetch(RPC_URL + fn, {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: 'Bearer ' + SUPABASE_ANON_KEY
        },
        body: JSON.stringify(params)
      });
    } catch (e) { /* best effort, bewusst kein Fehlerhandling */ }
  }

  function wireHelpButton() {
    var t = team();
    var btn = document.getElementById('helpBtn');
    if (!t || !btn) return;

    function setHelpState(active) {
      btn.textContent = active ? 'Help Requested - Cancel' : 'Request Help';
      btn.classList.toggle('active', !!active);
      btn.classList.remove('pending');
    }

    client.from('teams').select('hilfe_angefordert').eq('team', Number(t)).maybeSingle()
      .then(function (res) {
        setHelpState(!!(res.data && res.data.hilfe_angefordert));
      });

    btn.addEventListener('click', function () {
      var wasActive = btn.classList.contains('active');
      btn.disabled = true;
      btn.classList.add('pending');
      btn.textContent = wasActive ? 'Canceling...' : 'Requesting...';
      client.rpc('toggle_help', { p_team: Number(t) })
        .then(function (res) {
          if (res.error) {
            console.error('Help toggle failed:', res.error.message);
            setHelpState(wasActive);
            return;
          }
          var row = res.data && res.data[0];
          setHelpState(!!(row && row.hilfe_angefordert));
        })
        .catch(function (err) {
          console.error('Help toggle request failed:', err);
          setHelpState(wasActive);
        })
        .finally(function () { btn.disabled = false; });
    });
  }

  global.Mission = {
    client: client,
    team: team,

    initPage: function (page) {
      var t = team();
      if (t) client.rpc('set_progress', { p_team: Number(t), p_page: page, p_status: 'open' });
      wireHelpButton();
    },

    markDone: function (page) {
      var t = team();
      if (t) rpcKeepalive('set_progress', { p_team: Number(t), p_page: page, p_status: 'done' });
    },

    wireHelpButton: wireHelpButton,

    // Startzeitpunkt + aktuelle Serverzeit in einem Aufruf (fuer Countdown-Sync).
    getStatus: function () {
      return client.rpc('get_mission_status').then(function (res) {
        if (res.error) throw res.error;
        var row = res.data && res.data[0];
        return { startTime: row ? row.start_time : null, serverTime: row ? row.server_time : null };
      });
    },

    getTeams: function () {
      return client.from('teams').select('*').order('team').then(function (res) {
        if (res.error) throw res.error;
        return res.data;
      });
    },

    setStartTime: function (value) {
      return client.from('mission_settings').upsert({ key: 'start_time', value: value || null });
    },

    startNow: function () {
      var iso = new Date().toISOString();
      return Mission.setStartTime(iso).then(function () { return iso; });
    },

    updateField: function (t, field, value) {
      return client.rpc('update_field', { p_team: Number(t), p_field: field, p_value: value });
    },

    resetTeam: function (t) {
      return client.rpc('reset_team', { p_team: Number(t) });
    },

    resetAll: function () {
      return client.rpc('reset_all_teams');
    },

    // Realtime-Abo auf Änderungen an der teams-Tabelle (ersetzt Polling).
    // callback wird bei jeder Änderung ohne Argumente aufgerufen - der Aufrufer
    // liest sich per getTeams() den aktuellen Gesamtstand.
    subscribeTeams: function (callback) {
      return client.channel('teams-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, callback)
        .subscribe();
    }
  };
})(window);
