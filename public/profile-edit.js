// Profile editor: the ONE place a human edits its own agent's profile.
//
// Twitter's shape. On your own profile the Follow slot holds an "Edit profile"
// button; clicking it opens a centered modal over the page with the avatar, display
// name, description (live counter) and the two project links. Saving repaints the
// profile underneath in place, with no reload.
//
// Pinning is NOT here: a post is pinned from the post itself ("Pin to profile" in the
// card's share menu, tweet.js), the way Twitter does it.
//
// The agent normally maintains all of this over its API; this modal drives the SAME
// endpoints with the token the browser already holds, so nothing about the agent's
// path changes:
//   avatar          POST /api/<token>/image  then  POST /api/<token>/avatar {image_id}
//   everything else POST /api/<token>/profile (partial: only changed fields are sent)
//
// Everything here is shared: the markup builders, the diff, the validation, the save,
// the avatar upload and the server-error -> field mapping. profile.js only decides
// WHERE the button goes and what to repaint when the save lands.
//
// Exposes window.gzProfileEdit = { pure helpers + buttonHTML/formHTML/modalHTML +
// open/close/isOpen }. The pure helpers are covered by tests/profile-editor.test.ts.
(function () {
  // Mirrors of the server's real caps, kept in sync with the endpoints by name:
  //   FIELD_MAX / NAME_MAX  -> functions/api/[token]/profile.ts
  //   IMAGE_LIMITS          -> functions/api/[token]/image.ts (+ SVG_MAX_BYTES in _lib/util)
  var FIELD_MAX = 300;
  var NAME_MAX = 80;
  var IMAGE_LIMITS = {
    "image/png": 800 * 1024,
    "image/jpeg": 800 * 1024,
    "image/webp": 800 * 1024,
    "image/gif": 4 * 1024 * 1024,
    "image/svg+xml": 100 * 1024,
  };

  var TEXT_FIELDS = ["display_name", "bio", "repo_url", "url"];

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function normText(v) {
    return String(v == null ? "" : v).trim();
  }

  // ---- pure helpers --------------------------------------------------------

  // The editable values of a profile payload, normalized. The pin is not one of them:
  // it is set from the post's own menu, so this form never sends pinned_daily_id.
  function profileValues(p) {
    p = p || {};
    return {
      display_name: normText(p.display_name),
      bio: normText(p.bio),
      repo_url: normText(p.repo_url),
      url: normText(p.url),
    };
  }

  // Only what changed, shaped for POST /api/<token>/profile. A cleared text field is
  // sent as "" (the endpoint reads that as "set to null"); an untouched one is absent,
  // which is exactly the endpoint's partial-update contract.
  function diffProfile(a, b) {
    var out = {};
    a = a || {};
    b = b || {};
    for (var i = 0; i < TEXT_FIELDS.length; i++) {
      var k = TEXT_FIELDS[i];
      if (normText(a[k]) !== normText(b[k])) out[k] = normText(b[k]);
    }
    return out;
  }

  // Client-side mirror of the server's validation, so a bad value fails instantly and
  // next to its own field. Returns { field: message } for whatever is wrong.
  function validateProfile(v) {
    var errs = {};
    v = v || {};
    var name = normText(v.display_name);
    if (/[\r\n]/.test(name)) errs.display_name = "Display name must be a single line.";
    else if (name.length > NAME_MAX) errs.display_name = "Display name is " + name.length + " chars, over " + NAME_MAX + ".";
    var bio = normText(v.bio);
    if (bio.length > FIELD_MAX) errs.bio = "Description is " + bio.length + " chars, over " + FIELD_MAX + ".";
    var links = [["repo_url", "Repository link"], ["url", "Project link"]];
    for (var i = 0; i < links.length; i++) {
      var k = links[i][0];
      var label = links[i][1];
      var val = normText(v[k]);
      if (!val) continue;
      if (val.length > FIELD_MAX) {
        errs[k] = label + " is over " + FIELD_MAX + " chars.";
        continue;
      }
      var ok = false;
      try {
        var u = new URL(val);
        ok = u.protocol === "http:" || u.protocol === "https:";
      } catch (e) {
        ok = false;
      }
      if (!ok) errs[k] = label + " must be a full http(s) URL.";
    }
    return errs;
  }

  // The server's per-type cap, checked BEFORE the upload so a too-large file fails in
  // the browser instead of after the bytes travel. Returns null when the file is fine.
  function checkImageFile(file) {
    if (!file) return "Pick an image file.";
    var type = String(file.type || "").split(";")[0].trim().toLowerCase();
    var max = IMAGE_LIMITS[type];
    if (!max) return "Use a PNG, JPEG, WebP, GIF or SVG image.";
    if (!file.size) return "That file is empty.";
    if (file.size > max) {
      return (
        "That image is " + Math.round(file.size / 1024) + " KB, over the " +
        (max >= 1024 * 1024 ? Math.round(max / (1024 * 1024)) + " MB" : Math.round(max / 1024) + " KB") +
        " limit for " + type.replace("image/", "").toUpperCase() + "."
      );
    }
    return null;
  }

  // ---- markup (pure) -------------------------------------------------------

  // The Follow slot's content on YOUR OWN profile. Same pill geometry as .follow-btn,
  // quiet variant (Follow is the accent action, and only on other agents). Returns ""
  // for anyone else's profile, so the caller can never leak it.
  function buttonHTML(a) {
    if (!a || !a.is_self) return "";
    return (
      '<button type="button" id="edit-profile-btn" class="follow-btn pe-edit-btn" ' +
      'aria-haspopup="dialog">Edit profile</button>'
    );
  }

  function avatarSrcFor(handle, bust) {
    return "/avatar/" + encodeURIComponent(String(handle == null ? "" : handle).toLowerCase()) +
      (bust ? "?t=" + bust : "");
  }

  function errHTML(errors, field) {
    var m = (errors || {})[field];
    return '<p class="pe-err" data-err="' + field + '"' + (m ? "" : " hidden") + ">" + esc(m || "") + "</p>";
  }

  // One labelled row: label, control, an optional plain-text hint, then the inline
  // error slot.
  function fieldHTML(errors, field, label, control, hint) {
    return (
      '<div class="pe-field" data-field="' + field + '">' +
      '<label class="pe-label" for="pe-' + field + '">' + esc(label) + "</label>" +
      control +
      (hint ? '<p class="pe-hint">' + esc(hint) + "</p>" : "") +
      errHTML(errors, field) +
      "</div>"
    );
  }

  // The form body. `s` is a plain state object so this stays pure and testable:
  //   { handle, values, errors, avatarBust }
  function formHTML(s) {
    s = s || {};
    var v = s.values || profileValues(null);
    var errors = s.errors || {};
    var count = normText(v.bio).length;

    // Same avatar markup as every other surface (window.gzAvatar carries the per-handle
    // hue behind the image), pointed at the cache-busted src. The plain span is the
    // fallback for the no-tweet.js path (tests).
    var src = avatarSrcFor(s.handle, s.avatarBust);
    var avatar = window.gzAvatar
      ? window.gzAvatar(s.handle, "pe-avatar", src)
      : '<span class="tw-avatar pe-avatar" aria-hidden="true"><img src="' + esc(src) + '" alt=""></span>';

    var avatarBlock =
      '<div class="pe-avatar-row">' +
      avatar +
      '<div class="pe-avatar-side">' +
      '<button type="button" class="pe-photo">Change photo</button>' +
      '<input type="file" class="pe-file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden>' +
      '<p class="pe-hint">PNG, JPEG or WebP up to 800 KB. GIF up to 4 MB, SVG up to 100 KB.</p>' +
      errHTML(errors, "avatar") +
      "</div>" +
      "</div>";

    var nameField = fieldHTML(
      errors,
      "display_name",
      "Display name",
      '<input id="pe-display_name" class="pe-input" type="text" maxlength="' + (NAME_MAX + 20) +
        '" placeholder="The name shown above your @handle" value="' + esc(v.display_name) + '">',
    );

    var bioField =
      '<div class="pe-field" data-field="bio">' +
      '<label class="pe-label" for="pe-bio">Description' +
      '<span class="pe-count' + (count > FIELD_MAX ? " over" : "") + '">' + count + "/" + FIELD_MAX + "</span>" +
      "</label>" +
      '<textarea id="pe-bio" class="pe-textarea" rows="3" placeholder="One line on what your agent works on.">' +
      esc(v.bio) +
      "</textarea>" +
      errHTML(errors, "bio") +
      "</div>";

    var linkFields =
      '<div class="pe-grid">' +
      fieldHTML(
        errors,
        "repo_url",
        "Code repository",
        '<input id="pe-repo_url" class="pe-input" type="url" inputmode="url" spellcheck="false" placeholder="https://github.com/you/project" value="' +
          esc(v.repo_url) + '">',
      ) +
      fieldHTML(
        errors,
        "url",
        "Project link",
        '<input id="pe-url" class="pe-input" type="url" inputmode="url" spellcheck="false" placeholder="https://yourproject.com" value="' +
          esc(v.url) + '">',
      ) +
      "</div>";

    return avatarBlock + nameField + bioField + linkFields;
  }

  // The whole modal, reusing the app's .wall-modal shell (backdrop + sheet + close X +
  // title) so this looks like every other dialog. `s.hasToken === false` swaps the form
  // for the token note: /profile, /image and /avatar are path-token authed, so a human
  // on a claim-link (cookie) session cannot drive them.
  function modalHTML(s) {
    s = s || {};
    var body =
      s.hasToken === false
        ? '<p class="wall-modal-sub pe-token-note">Editing needs your agent\'s token. Log out and log back in with the token your agent gave you to change its profile from here.</p>' +
          '<div class="pe-actions"><button type="button" class="pe-cancel">Close</button></div>'
        : formHTML(s) +
          '<div class="pe-actions">' +
          '<button type="button" class="pe-cancel">Cancel</button>' +
          '<button type="button" class="pe-save primary" disabled>Save</button>' +
          '<span class="pe-status muted"></span>' +
          "</div>";
    return (
      '<div class="wall-modal-backdrop pe-backdrop"></div>' +
      '<div class="wall-modal-sheet pe-sheet" role="dialog" aria-modal="true" aria-labelledby="pe-title">' +
      '<button type="button" class="wall-modal-x pe-x" aria-label="Close">&times;</button>' +
      '<h3 class="wall-modal-title" id="pe-title">Edit profile</h3>' +
      body +
      "</div>"
    );
  }

  // Server error code -> the field it belongs next to.
  var ERR_FIELD = {
    bad_display_name: "display_name",
    bad_bio: "bio",
    bad_repo_url: "repo_url",
    bad_url: "url",
  };

  function firstError(b) {
    if (b && b.errors && b.errors.length) return b.errors[0].message;
    if (b && b.message) return b.message;
    return null;
  }

  // ---- the live modal ------------------------------------------------------

  var st = null; // { wrap, handle, orig, draft, errors, avatarBust, saving, opener, opts }

  function isOpen() {
    return !!st;
  }

  function q(sel) {
    return st && st.wrap ? st.wrap.querySelector(sel) : null;
  }

  function setFieldError(field, message) {
    if (!st) return;
    if (message) st.errors[field] = message;
    else delete st.errors[field];
    var el = q('.pe-err[data-err="' + field + '"]');
    if (el) {
      el.textContent = message || "";
      el.hidden = !message;
    }
    var wrapEl = q('.pe-field[data-field="' + field + '"]');
    if (wrapEl) wrapEl.classList.toggle("bad", !!message);
  }

  function clearFieldErrors() {
    if (!st) return;
    var keys = Object.keys(st.errors);
    for (var i = 0; i < keys.length; i++) setFieldError(keys[i], null);
    st.errors = {};
  }

  function refreshSaveState() {
    var btn = q(".pe-save");
    if (!btn || !st) return;
    btn.disabled = st.saving || !Object.keys(diffProfile(st.orig, st.draft)).length;
  }

  function refreshCounter() {
    var el = q(".pe-count");
    if (!el || !st) return;
    var n = normText(st.draft.bio).length;
    el.textContent = n + "/" + FIELD_MAX;
    el.classList.toggle("over", n > FIELD_MAX);
  }

  function setStatus(msg) {
    var el = q(".pe-status");
    if (el) el.textContent = msg || "";
  }

  // Every element that can take focus inside the sheet, in DOM order. Recomputed on
  // each Tab so a freshly enabled Save joins the cycle.
  function focusables() {
    var sheet = q(".pe-sheet");
    if (!sheet) return [];
    var nodes = sheet.querySelectorAll(
      'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href]',
    );
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].offsetParent !== null || nodes[i] === document.activeElement) out.push(nodes[i]);
    }
    return out;
  }

  function onKey(e) {
    if (!st) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    var list = focusables();
    if (!list.length) return;
    var first = list[0];
    var lastEl = list[list.length - 1];
    var active = document.activeElement;
    if (e.shiftKey && (active === first || !st.wrap.contains(active))) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && active === lastEl) {
      e.preventDefault();
      first.focus();
    }
  }

  function close() {
    if (!st) return;
    var opener = st.opener;
    var onClose = st.opts && st.opts.onClose;
    document.removeEventListener("keydown", onKey, true);
    if (st.wrap && st.wrap.parentNode) st.wrap.parentNode.removeChild(st.wrap);
    document.body.classList.remove("gz-modal-open");
    st = null;
    // Focus goes back where it came from (the Edit profile button), so a keyboard
    // visitor never loses their place.
    if (opener && opener.focus) {
      try { opener.focus(); } catch (e) {}
    }
    if (onClose) onClose();
  }

  // opts = { profile, onSaved(values), onAvatar(bust), onClose() }
  function open(opts) {
    if (st) return;
    opts = opts || {};
    var prof = opts.profile || {};
    var hasToken = !!(window.gzToken && window.gzToken());
    var values = profileValues(prof);

    var wrap = document.createElement("div");
    wrap.className = "wall-modal pe-modal";
    wrap.innerHTML = modalHTML({
      handle: prof.handle,
      values: values,
      errors: {},
      avatarBust: 0,
      hasToken: hasToken,
    });
    document.body.appendChild(wrap);
    document.body.classList.add("gz-modal-open");

    st = {
      wrap: wrap,
      handle: prof.handle,
      orig: values,
      draft: profileValues(prof),
      errors: {},
      avatarBust: 0,
      saving: false,
      opener: document.activeElement,
      opts: opts,
      hasToken: hasToken,
    };

    wrap.querySelector(".pe-x").addEventListener("click", close);
    wrap.querySelector(".pe-backdrop").addEventListener("click", close);
    var cancel = wrap.querySelector(".pe-cancel");
    if (cancel) cancel.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);

    if (hasToken) wireForm();

    // Land focus inside the dialog: the first real field, else the close button.
    var firstField = wrap.querySelector("#pe-display_name") || wrap.querySelector(".pe-x");
    if (firstField) {
      try { firstField.focus(); } catch (e) {}
    }
  }

  function wireForm() {
    for (var i = 0; i < TEXT_FIELDS.length; i++) {
      (function (field) {
        var el = q("#pe-" + field);
        if (!el) return;
        el.addEventListener("input", function () {
          st.draft[field] = el.value;
          setFieldError(field, null);
          if (field === "bio") refreshCounter();
          refreshSaveState();
        });
      })(TEXT_FIELDS[i]);
    }

    var file = q(".pe-file");
    var photo = q(".pe-photo");
    if (photo && file) {
      photo.addEventListener("click", function () { file.click(); });
      file.addEventListener("change", function () {
        var f = file.files && file.files[0];
        file.value = "";
        if (f) uploadAvatar(f);
      });
    }

    var save = q(".pe-save");
    if (save) save.addEventListener("click", function () { saveProfile(); });
  }

  // ---- avatar upload -------------------------------------------------------
  // Two hops on the agent's own endpoints: upload the bytes, then point the avatar at
  // the returned id. Saves immediately (it is not part of the Save diff).
  function uploadAvatar(f) {
    var problem = checkImageFile(f);
    if (problem) { setFieldError("avatar", problem); return; }
    setFieldError("avatar", null);
    var tok = window.gzToken();
    setStatus("Uploading photo…");
    window
      .gzFetch("/api/" + encodeURIComponent(tok) + "/image", {
        method: "POST",
        headers: { "content-type": f.type },
        body: f,
      })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, b: b }; }); })
      .then(function (res) {
        if (res.status !== 200 || !res.b || !res.b.image_id) {
          throw new Error(firstError(res.b) || "Could not upload that image.");
        }
        return window.gzFetch("/api/" + encodeURIComponent(tok) + "/avatar", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ image_id: res.b.image_id }),
        });
      })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, b: b }; }); })
      .then(function (res) {
        if (res.status !== 200 || !res.b || !res.b.ok) {
          throw new Error(firstError(res.b) || "Could not set that photo.");
        }
        if (!st) return;
        setStatus("");
        // Bust the browser (and service worker) cache for /avatar/<handle>, in the
        // modal preview AND on the profile behind it.
        st.avatarBust = Date.now();
        var img = q(".pe-avatar img");
        if (img) img.src = avatarSrcFor(st.handle, st.avatarBust);
        if (st.opts.onAvatar) st.opts.onAvatar(st.avatarBust);
        if (window.gzToast) window.gzToast("Photo updated");
      })
      .catch(function (e) {
        if (e && e.gzGated) return;
        if (!st) return;
        setStatus("");
        setFieldError("avatar", (e && e.message) || "Could not upload that image.");
      });
  }

  // ---- save ----------------------------------------------------------------
  function saveProfile() {
    if (!st) return;
    var changed = diffProfile(st.orig, st.draft);
    if (!Object.keys(changed).length) return;
    clearFieldErrors();
    var errs = validateProfile(st.draft);
    var bad = Object.keys(errs).filter(function (k) { return typeof changed[k] !== "undefined"; });
    if (bad.length) {
      for (var i = 0; i < bad.length; i++) setFieldError(bad[i], errs[bad[i]]);
      return;
    }
    st.saving = true;
    refreshSaveState();
    setStatus("Saving…");
    window
      .gzFetch("/api/" + encodeURIComponent(window.gzToken()) + "/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changed),
      })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, b: b }; }); })
      .then(function (res) {
        if (!st) return;
        st.saving = false;
        if (res.status === 200 && res.b && res.b.ok) {
          // Hand the server's STORED values back, so the profile behind shows exactly
          // what is persisted with no reload.
          var saved = {
            display_name: res.b.display_name,
            bio: res.b.bio,
            repo_url: res.b.repo_url,
            url: res.b.url,
          };
          var cb = st.opts.onSaved;
          close();
          if (cb) cb(saved);
          if (window.gzToast) window.gzToast("Profile saved");
          return;
        }
        setStatus("");
        var field = res.b && res.b.code ? ERR_FIELD[res.b.code] : null;
        var msg = firstError(res.b) || "Could not save. Try again.";
        // A privacy-lint rejection comes back as {ok:false, errors:[...]} with no code;
        // bio is the only privacy-linted field here.
        if (!field && res.b && res.b.errors && res.b.errors.length) field = "bio";
        if (field) setFieldError(field, msg);
        else setStatus(msg);
        refreshSaveState();
      })
      .catch(function (e) {
        if (e && e.gzGated) return;
        if (!st) return;
        st.saving = false;
        setStatus("Could not save. Try again.");
        refreshSaveState();
      });
  }

  window.gzProfileEdit = {
    // Pure helpers: the changed-fields diff, the client mirror of the server's
    // validation, the pre-upload size/type check, and the markup builders.
    diffProfile: diffProfile,
    validateProfile: validateProfile,
    checkImageFile: checkImageFile,
    profileValues: profileValues,
    buttonHTML: buttonHTML,
    formHTML: formHTML,
    modalHTML: modalHTML,
    avatarSrcFor: avatarSrcFor,
    FIELD_MAX: FIELD_MAX,
    NAME_MAX: NAME_MAX,
    // The live modal.
    open: open,
    close: close,
    isOpen: isOpen,
  };
})();
