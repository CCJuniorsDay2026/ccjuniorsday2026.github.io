/**
 * Protocol 16 – gemeinsame Firebase/Firestore-Anbindung für alle Spielseiten.
 * Ersetzt die bisherige Supabase-Anbindung, weil Supabase auf manchen
 * Firmennetzen (z. B. Bank-Notebooks) von der Netzwerk-Firewall blockiert
 * wird, Firebase/Google-Domains dort aber durchgehen.
 *
 * Eingebunden wird das so (Reihenfolge wichtig):
 *   <script src="https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js"></script>
 *   <script src="https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore-compat.js"></script>
 *   <script src="mission-common.js"></script>
 *
 * Auf jeder Spielseite reicht dann:
 *   Mission.initPage('13');           // beim Laden: Fortschritt "open" + Hilfe-Button verdrahten
 *   Mission.markDone('13');           // wenn die Aufgabe gelöst ist, vor dem Seitenwechsel
 */
(function (global) {
  var firebaseConfig = {
    apiKey: "AIzaSyDJfW69cVuCN7zNnAXJqIUUd9DPjq7gk_A",
    authDomain: "protocol16.firebaseapp.com",
    projectId: "protocol16",
    storageBucket: "protocol16.firebasestorage.app",
    messagingSenderId: "1029357758272",
    appId: "1:1029357758272:web:9f5d5f076fc23d40967ca5"
  };

  global.firebase.initializeApp(firebaseConfig);
  var db = global.firebase.firestore();
  var FieldValue = global.firebase.firestore.FieldValue;

  var FIRESTORE_REST_BASE = 'https://firestore.googleapis.com/v1/projects/' + firebaseConfig.projectId + '/databases/(default)/documents';

  function team() {
    return sessionStorage.getItem('teamNumber');
  }

  function teamRef(t) {
    return db.collection('teams').doc(String(t));
  }

  // Zuverlässiger "Fire and forget"-Aufruf, auch wenn direkt danach die Seite
  // verlassen wird (Ersatz für fetch(..., { keepalive: true })). Geht bewusst
  // über die Firestore-REST-API statt über das SDK, weil das SDK Schreibvorgänge
  // nicht zuverlässig genug über eine sofortige Navigation hinweg garantiert.
  function restKeepaliveUpdate(t, fields, maskPaths) {
    try {
      var qs = maskPaths.map(function (p) { return 'updateMask.fieldPaths=' + encodeURIComponent(p); }).join('&');
      fetch(FIRESTORE_REST_BASE + '/teams/' + t + '?' + qs, {
        method: 'PATCH',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: fields })
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

    teamRef(t).get().then(function (snap) {
      var data = snap.data();
      setHelpState(!!(data && data.hilfe_angefordert));
    });

    // Live mithören: falls Mission Control (oder ein anderes Gerät desselben
    // Teams) den Hilfe-Status ändert, soll der Button das ohne Reload zeigen -
    // sonst bleibt er "an", auch nachdem Mission Control ihn ausgeschaltet hat.
    teamRef(t).onSnapshot(function (snap) {
      if (btn.classList.contains('pending')) return; // eigener Klick läuft gerade, der regelt den Endzustand selbst
      var data = snap.data();
      setHelpState(!!(data && data.hilfe_angefordert));
    });

    btn.addEventListener('click', function () {
      var wasActive = btn.classList.contains('active');
      btn.disabled = true;
      btn.classList.add('pending');
      btn.textContent = wasActive ? 'Canceling...' : 'Requesting...';

      // Transaktion statt einfachem Update: liest den aktuellen Stand und schreibt
      // das Gegenteil, atomar - zwei fast gleichzeitige Klicks (Team + Mission
      // Control) können sich so nicht widersprüchlich überschreiben.
      db.runTransaction(function (tx) {
        var ref = teamRef(t);
        return tx.get(ref).then(function (snap) {
          var current = snap.data() && snap.data().hilfe_angefordert;
          var next = current ? null : FieldValue.serverTimestamp();
          tx.update(ref, { hilfe_angefordert: next, last_update: FieldValue.serverTimestamp() });
          return !current;
        });
      })
        .then(function (nowActive) { setHelpState(nowActive); })
        .catch(function (err) {
          console.error('Help toggle failed:', err);
          setHelpState(wasActive);
        })
        .finally(function () { btn.disabled = false; });
    });
  }

  function normalizeTeam(data) {
    var out = {};
    for (var k in data) out[k] = data[k];
    ['locked_in_at', 'last_update', 'hilfe_angefordert'].forEach(function (k) {
      if (out[k] && out[k].toDate) out[k] = out[k].toDate().toISOString();
    });
    if (out.progress) {
      var p = {};
      for (var pk in out.progress) {
        var v = out.progress[pk];
        p[pk] = (v && v.toDate) ? v.toDate().toISOString() : v;
      }
      out.progress = p;
    }
    return out;
  }

  global.Mission = {
    db: db,
    team: team,

    // Login: setzt locked_in_at nur, wenn das Team noch nicht eingeloggt ist.
    // Per Transaktion atomar - zwei Logins für dasselbe Team können sich
    // dadurch nicht mehr überschreiben oder in einen unklaren Zustand laufen.
    login: function (t) {
      return db.runTransaction(function (tx) {
        var ref = teamRef(t);
        return tx.get(ref).then(function (snap) {
          if (!snap.exists) return { status: 'error' };
          var data = snap.data();
          if (data.locked_in_at) {
            return { status: 'ok', already_logged_in: true };
          }
          tx.update(ref, { locked_in_at: FieldValue.serverTimestamp(), last_update: FieldValue.serverTimestamp() });
          return { status: 'ok', already_logged_in: false };
        });
      });
    },

    initPage: function (page) {
      var t = team();
      if (t) {
        var update = { last_update: FieldValue.serverTimestamp() };
        update['progress.page_' + page] = 'open';
        teamRef(t).update(update)
          .catch(function (err) { console.error('set_progress(open) fehlgeschlagen:', err.message); });
      }
      wireHelpButton();
    },

    markDone: function (page) {
      var t = team();
      if (!t) return;
      var nowIso = new Date().toISOString();
      var progressFields = {};
      progressFields['page_' + page] = { stringValue: nowIso };
      restKeepaliveUpdate(t, {
        progress: { mapValue: { fields: progressFields } },
        last_update: { timestampValue: nowIso }
      }, ['progress.page_' + page, 'last_update']);
    },

    wireHelpButton: wireHelpButton,

    // Startzeitpunkt + aktuelle Zeit in einem Aufruf (fuer Countdown-Sync).
    // Hinweis: "serverTime" ist hier die Uhrzeit des jeweiligen Geräts, nicht
    // eine echte Serverzeit wie vorher bei Postgres - Firestore hat dafür
    // keinen einfachen Abruf ohne zusätzlichen Schreibvorgang. In der Praxis
    // unkritisch, solange die Geräte halbwegs synchron laufen (NTP).
    getStatus: function () {
      return db.collection('mission_settings').doc('config').get().then(function (snap) {
        var data = snap.data() || {};
        var startTime = null;
        if (data.start_time) {
          startTime = data.start_time.toDate ? data.start_time.toDate().toISOString() : data.start_time;
        }
        return { startTime: startTime, serverTime: new Date().toISOString() };
      });
    },

    getTeams: function () {
      return db.collection('teams').orderBy('team').get().then(function (snap) {
        return snap.docs.map(function (d) { return normalizeTeam(d.data()); });
      });
    },

    setStartTime: function (value) {
      return db.collection('mission_settings').doc('config').set({ start_time: value || null }, { merge: true });
    },

    startNow: function () {
      var iso = new Date().toISOString();
      return Mission.setStartTime(iso).then(function () { return iso; });
    },

    updateField: function (t, field, value) {
      if (['raum', 'sprache', 'mission_control'].indexOf(field) === -1) return Promise.resolve();
      var update = {};
      update[field] = value;
      return teamRef(t).update(update);
    },

    resetTeam: function (t) {
      return teamRef(t).update({ locked_in_at: null, last_update: null, hilfe_angefordert: null, progress: {} });
    },

    resetAll: function () {
      return db.collection('teams').get().then(function (snap) {
        var batch = db.batch();
        snap.docs.forEach(function (d) {
          batch.update(d.ref, { locked_in_at: null, last_update: null, hilfe_angefordert: null, progress: {} });
        });
        return batch.commit();
      });
    },

    // Hilfe-Anfrage eines Teams gezielt deaktivieren (von Mission Control aus).
    // Bewusst kein "toggle" wie beim Team-eigenen Button, sondern ein explizites
    // "aus" - so bleibt das Ergebnis eindeutig, egal was das Team gerade selbst tut.
    clearHelp: function (t) {
      return teamRef(t).update({ hilfe_angefordert: null, last_update: FieldValue.serverTimestamp() });
    },

    // Realtime-Abo auf Änderungen an der teams-Sammlung (ersetzt Polling).
    // callback wird bei jeder Änderung ohne Argumente aufgerufen - der Aufrufer
    // liest sich per getTeams() den aktuellen Gesamtstand.
    subscribeTeams: function (callback) {
      return db.collection('teams').onSnapshot(function () { callback(); });
    }
  };
})(window);
