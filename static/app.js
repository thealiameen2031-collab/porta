const $ = (selector, root = document) => root.querySelector(selector);
const TOKEN_KEY = "porta.accessToken";
const THEME_KEY = "porta.theme";
let currentUser = null;
let activeAvatarStyle = null;
let oauthProfileCompletion = false;
let pendingOAuthPhoneVerification = false;
let pendingRegistrationId = "";
let pendingRegistrationStage = "phone";
let verificationResendTimer = 0;
const AVATAR_STYLE_KEY = "porta.avatarStyle";
const PROFILE_PHOTO_KEY = "porta.profilePhoto";
const avatarStorageKey = key => `${key}:${currentUser?.id || "guest"}`;

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

const tagStates = new WeakMap();
const tagRenderers = new WeakMap();
const countryCodes = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" ");
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const countries = countryCodes.map(code => countryNames.of(code)).filter(Boolean).sort((a, b) => a.localeCompare(b));
const languageSuggestions = "Arabic,English,French,German,Hindi,Italian,Japanese,Korean,Malayalam,Mandarin,Portuguese,Punjabi,Russian,Spanish,Swahili,Tagalog,Turkish,Urdu".split(",");
const additionalTopicSuggestions = "3D modeling,accounting,acting,architecture,astronomy,astrophysics,automotive repair,baking,beauty,blogging,branding,building apps,career planning,ceramics,child development,climate science,communication,community building,composing music,conflict resolution,copywriting,cybersecurity,data analysis,data science,debate,digital art,digital marketing,DIY,documentary filmmaking,drama,ecology,economics,education,electronics,engineering,environmental science,event planning, fashion,first aid,food photography,game development,gardening,geography,health,illustration,interior design,investing,journalism,leadership,law,logo design,management,medicine,mental health,mobile app development,modeling,motion graphics,negotiation,nutrition,painting,personal finance,philosophy,physics,product design,project management,pronunciation,public relations,robotics,screenwriting,SEO,singing,sketching,statistics,storytelling,UX design,UX research,voice acting,volunteering,woodworking,yoga".split(",").map(value => value.trim());
let phoneCodesByRegion = new Map();

function createSuggestionMenu(input, menu, items, onChoose) {
  let activeIndex = -1;
  const close = () => {
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    activeIndex = -1;
  };
  const render = query => {
    const normalized = query.trim().toLocaleLowerCase();
    const matches = items()
      .filter(item => !normalized || item.toLocaleLowerCase().startsWith(normalized))
      .slice(0, 50);
    menu.replaceChildren();
    matches.forEach((item, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "suggestion-option";
      option.id = `${menu.id}-option-${index}`;
      option.setAttribute("role", "option");
      option.textContent = item;
      option.addEventListener("mousedown", event => event.preventDefault());
      option.addEventListener("click", () => {
        onChoose(item);
        close();
      });
      menu.append(option);
    });
    menu.hidden = matches.length === 0;
    input.setAttribute("aria-expanded", String(matches.length > 0));
    activeIndex = -1;
  };
  input.addEventListener("focus", () => render(input.value));
  input.addEventListener("input", () => render(input.value));
  input.addEventListener("keydown", event => {
    const options = [...menu.querySelectorAll(".suggestion-option")];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (menu.hidden || !options.length) return;
      event.preventDefault();
      activeIndex = (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options.forEach((option, index) => option.setAttribute("aria-selected", String(index === activeIndex)));
      input.setAttribute("aria-activedescendant", options[activeIndex].id);
    } else if (event.key === "Escape") {
      close();
    } else if (event.key === "Enter" && activeIndex >= 0 && options[activeIndex]) {
      event.preventDefault();
      options[activeIndex].click();
    }
  });
  input.addEventListener("blur", () => window.setTimeout(close, 100));
  return { close, render };
}

function initializeCountryPicker() {
  const input = $("#register-location");
  const menu = $("#country-suggestions");
  createSuggestionMenu(input, menu, () => countries, value => {
    input.value = value;
    input.dataset.selectedCountry = value;
    const region = countryCodes.find(code => countryNames.of(code) === value);
    if (region && phoneCodesByRegion.has(region)) $("#register-phone-code").value = region;
  });
  input.addEventListener("input", () => {
    if (input.value !== input.dataset.selectedCountry) delete input.dataset.selectedCountry;
  });
}

function initializeTagInputs() {
  document.querySelectorAll("[data-tag-input]").forEach(container => {
    const name = container.dataset.name;
    const input = $(".tag-input-control", container);
    const menu = $(".suggestion-list", container);
    const valuesBox = $(".tag-values", container);
    const suggestions = name === "languages"
      ? languageSuggestions
      : [...new Set([...(container.dataset.suggestions || "").split(",").filter(Boolean), ...additionalTopicSuggestions])];
    const selected = [];
    tagStates.set(container, selected);
    const max = Number(container.dataset.limit || 0);
    const renderTags = () => {
      valuesBox.replaceChildren();
      selected.forEach((value, index) => {
        const chip = document.createElement("span");
        chip.className = "selected-tag";
        chip.append(document.createTextNode(value));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${value}`);
        remove.textContent = "×";
        remove.addEventListener("click", () => {
          selected.splice(index, 1);
          renderTags();
          input.focus();
        });
        chip.append(remove);
        valuesBox.append(chip);
        const hidden = document.createElement("input");
        hidden.type = "hidden";
        hidden.name = name;
        hidden.value = value;
        valuesBox.append(hidden);
      });
      input.disabled = Boolean(max && selected.length >= max);
      input.placeholder = input.disabled ? "Up to 3 selected" : input.dataset.placeholder;
    };
    tagRenderers.set(container, renderTags);
    input.dataset.placeholder = input.placeholder;
    const add = value => {
      const cleaned = value.trim().replace(/\s+/g, " ");
      if (!cleaned || selected.some(item => item.toLocaleLowerCase() === cleaned.toLocaleLowerCase())) return;
      if (max && selected.length >= max) return;
      selected.push(cleaned.slice(0, 60));
      input.value = "";
      renderTags();
    };
    const menuController = createSuggestionMenu(input, menu, () => suggestions, add);
    input.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === ",") {
        if (event.key === "," || !menuController || !input.getAttribute("aria-activedescendant")) {
          event.preventDefault();
          add(input.value.replace(/,$/, ""));
          menuController.close();
        }
      } else if (event.key === "Backspace" && !input.value && selected.length) {
        selected.pop();
        renderTags();
      }
    });
    container.addEventListener("click", event => {
      if (!event.target.closest(".selected-tag button")) input.focus();
    });
    renderTags();
  });
}

initializeCountryPicker();
initializeTagInputs();

async function apiRequest(url, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Porta returned an unreadable response. Please try again.");
  }
  if (!response.ok) {
    const detail = Array.isArray(payload.detail)
      ? payload.detail.map(item => item.msg).join(" ")
      : payload.detail;
    const error = new Error(detail || `Request failed (${response.status}). Please try again.`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function loadPhoneCallingCodes() {
  const select = $("#register-phone-code");
  const status = $("#phone-code-status");
  try {
    const { regions } = await apiRequest("/api/phone-codes");
    phoneCodesByRegion = new Map(regions.map(item => [item.region, item.calling_code]));
    select.replaceChildren(...regions.map(({ region, calling_code }) => {
      const option = document.createElement("option");
      option.value = region;
      option.textContent = `${countryNames.of(region) || region} (+${calling_code})`;
      return option;
    }));
    select.disabled = false;
    const countryInput = $("#register-location");
    const selectedCountry = countryInput.dataset.selectedCountry || countryInput.value;
    const selectedRegion = countryCodes.find(code => countryNames.of(code) === selectedCountry) || "QA";
    select.value = phoneCodesByRegion.has(selectedRegion) ? selectedRegion : "QA";
    countryInput.dataset.selectedCountry = countryNames.of(selectedRegion);
    status.textContent = phoneCodesByRegion.has(selectedRegion)
      ? "Country calling code is selected separately from your number."
      : "This region has no dedicated calling code. Enter your full international number starting with +.";
    countryInput.dispatchEvent(new Event("input"));
  } catch (error) {
    status.textContent = `Could not load country calling codes. ${error.message}`;
    setAuthFeedback($("#register-feedback"), "Country codes did not load. Refresh Porta and try again.");
  }
}

async function loadLearningPaths() {
  const board = $("#skill-board");
  try {
    const { paths } = await apiRequest("/api/learning-paths");
    board.innerHTML = paths.map((path, index) => `
      <button class="skill-tile skill-${escapeHtml(path.color)}" type="button" data-skill="${escapeHtml(path.title)}">
        <span class="skill-symbol">${escapeHtml(path.icon)}</span>
        <span class="skill-copy"><b>${escapeHtml(path.title)}</b><small>${escapeHtml(path.category)}</small></span>
        <span class="skill-number">0${index + 1}</span>
      </button>`).join("");
  } catch (error) {
    board.innerHTML = `<p class="inline-error">${escapeHtml(error.message)}</p>`;
  }
}

loadPhoneCallingCodes();

function setAuthFeedback(element, message = "", state = "") {
  element.textContent = message;
  element.classList.toggle("success", state === "success");
}

function showRegistrationVerification(result) {
  pendingRegistrationId = result.verification_id || pendingRegistrationId;
  pendingRegistrationStage = result.stage;
  $("#register-form").hidden = true;
  $(".auth-switch", $("#register-panel")).hidden = true;
  $("#register-verification").hidden = false;
  $("#verification-code").value = "";
  setAuthFeedback($("#verification-feedback"));
  if (pendingRegistrationStage === "email") {
    $("#verification-kicker").textContent = "STEP 2 OF 2";
    $("#verification-title").textContent = "Verify your email";
    $("#verification-description").textContent =
      `Your WhatsApp number is verified. Enter the 6-digit code we emailed to ${result.email_hint || "your email address"}.`;
    $("#verify-code-button").innerHTML = 'Verify email and create account <span aria-hidden="true">→</span>';
  } else {
    $("#verification-kicker").textContent = "STEP 1 OF 2";
    $("#verification-title").textContent = "Verify your WhatsApp number";
    const phoneNumber = normalizePhoneNumber(
      $("#register-phone").value,
      $("#register-phone-code").value,
    );
    $("#verification-description").textContent =
      `Enter the 6-digit code sent by WhatsApp to ${phoneNumber}.`;
    $("#verify-code-button").innerHTML = 'Verify number <span aria-hidden="true">→</span>';
  }
  startVerificationResendCooldown(result.resend_after_seconds || 60);
  $("#verification-code").focus();
}

function normalizePhoneNumber(value, region) {
  const phoneText = String(value || "").trim();
  if (phoneText.startsWith("+")) return `+${phoneText.replace(/\D/g, "")}`;
  const dialCode = phoneCodesByRegion.get(region);
  return dialCode ? `+${dialCode}${phoneText.replace(/\D/g, "")}` : "";
}

function startVerificationResendCooldown(seconds) {
  const button = $("#resend-verification");
  window.clearInterval(verificationResendTimer);
  let remaining = seconds;
  button.disabled = remaining > 0;
  const update = () => {
    button.textContent = remaining > 0 ? `Send a new code in ${remaining}s` : "Send a new code";
    button.disabled = remaining > 0;
    if (remaining <= 0) window.clearInterval(verificationResendTimer);
    remaining -= 1;
  };
  update();
  verificationResendTimer = window.setInterval(update, 1000);
}

function resetRegistrationVerification() {
  window.clearInterval(verificationResendTimer);
  pendingRegistrationId = "";
  pendingRegistrationStage = "phone";
  pendingOAuthPhoneVerification = false;
  $("#register-form").hidden = false;
  $(".auth-switch", $("#register-panel")).hidden = false;
  $("#register-verification").hidden = true;
  setAuthFeedback($("#verification-feedback"));
}

function setAuthMode(mode) {
  const isRegister = mode === "register";
  oauthProfileCompletion = false;
  pendingOAuthPhoneVerification = false;
  $("body").classList.remove("profile-completion");
  $("#login-panel").hidden = isRegister;
  $("#register-panel").hidden = !isRegister;
  $("#password-reset-panel").hidden = true;
  resetRegistrationVerification();
  $(".auth-tabs").hidden = false;
  $("#login-tab").classList.toggle("active", !isRegister);
  $("#register-tab").classList.toggle("active", isRegister);
  $("#login-tab").setAttribute("aria-selected", String(!isRegister));
  $("#register-tab").setAttribute("aria-selected", String(isRegister));
  setAuthFeedback($("#login-feedback"));
  setAuthFeedback($("#register-feedback"));
  if (isRegister) $("#register-first-name").focus();
  else $("#login-email").focus();
}

function showPasswordReset(token = "") {
  $("#login-panel").hidden = true;
  $("#register-panel").hidden = true;
  $("#password-reset-panel").hidden = false;
  $(".auth-tabs").hidden = true;
  $("#password-reset-request-form").hidden = Boolean(token);
  $("#password-reset-confirm-form").hidden = !token;
  $("#password-reset-title").textContent = token ? "Choose a new password." : "Reset your password.";
  $("#reset-request-feedback").textContent = "";
  $("#reset-confirm-feedback").textContent = "";
  if (token) {
    $("#reset-confirm-password").dataset.token = token;
    $("#reset-new-password").focus();
  } else {
    $("#reset-email").value = $("#login-email").value;
    $("#reset-email").focus();
  }
}

function profileInitials(user) {
  return user.full_name.split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
}

function renderProfile(user) {
  if (!user.profile_complete) {
    showProfileCompletion(user);
    return;
  }
  const firstName = user.full_name.split(/\s+/)[0];
  $("#welcome-name").textContent = firstName;
  $("#welcome-avatar").textContent = profileInitials(user);
  $("#profile-name-heading").textContent = `${firstName}’s`;
  $("#sidebar-account-name").textContent = user.full_name;
  $("#topbar-account-name").textContent = user.full_name;
  $("#sidebar-user-avatar").textContent = profileInitials(user);
  $("#topbar-user-avatar").textContent = profileInitials(user);
  $("#account-email-detail").textContent = user.email;
  $("#account-phone-detail").textContent = user.phone_number || "Not added";
  activeAvatarStyle = readAvatarStyle();
  renderAccountAvatar();
  const roleLabels = { learner: "Here to learn", peer_tutor: "Here to share", both: "Here to learn & share" };
  const styles = { one_to_one: "One-to-one", small_group: "Small group", flexible: "Flexible" };
  const interests = user.interests.map(value => `<span class="profile-pill">${escapeHtml(value)}</span>`).join("");
  const sharedSkills = user.skills_to_share.length
    ? user.skills_to_share.map(value => `<span class="profile-pill">${escapeHtml(value)}</span>`).join("")
    : '<span class="profile-pill">Still exploring</span>';
  $("#profile-card").innerHTML = `
    <div class="profile-card-header"><span class="profile-avatar">${escapeHtml(profileInitials(user))}</span>
      <div><h3>${escapeHtml(user.full_name)}</h3><p>@${escapeHtml(user.username || "porta-member")} · ${escapeHtml(user.location)} · ${escapeHtml((user.languages || [user.language]).join(", "))} · ${escapeHtml(roleLabels[user.role])}</p></div>
    </div>
    ${user.bio ? `<p class="profile-bio">${escapeHtml(user.bio)}</p>` : ""}
    <div class="profile-details">
      <div class="profile-detail"><span>Curious about</span><div class="profile-pills">${interests}</div></div>
      <div class="profile-detail"><span>Ready to share</span><div class="profile-pills">${sharedSkills}</div></div>
      <div class="profile-detail"><span>My learning goals</span><div class="profile-pills">${(user.learning_goals?.length ? user.learning_goals : [user.learning_goal || "Open to finding inspiration"]).map(value => `<span class="profile-pill">${escapeHtml(value)}</span>`).join("")}</div></div>
      <div class="profile-detail"><span>My learning style</span><div class="profile-pills"><span class="profile-pill">${escapeHtml(styles[user.learning_style] || styles.flexible)}</span></div></div>
    </div>`;
    const profileAvatar = $(".profile-avatar", $("#profile-card"));
    if (profileAvatar) {
      const photo = localStorage.getItem(avatarStorageKey(PROFILE_PHOTO_KEY));
      profileAvatar.replaceChildren();
      if (photo) {
        const image = document.createElement("img");
        image.src = photo;
        image.alt = "Your profile photo";
        profileAvatar.append(image);
      } else {
        profileAvatar.innerHTML = makeAvatarSvg(activeAvatarStyle);
      }
    }
    if (document.activeElement !== $("#edit-profile-form")) fillProfileEditor(user);
    $("body").classList.remove("profile-completion");
    $("body").classList.add("authenticated");
  if (user.learning_goal || user.interests.length) {
    $("#match-goal").value = user.learning_goal || user.interests.join(" ");
    $("#match-form").requestSubmit();
  }
}

function showProfileCompletion(user) {
  oauthProfileCompletion = true;
  $("body").classList.remove("authenticated");
  $("body").classList.add("profile-completion");
  $(".auth-tabs").hidden = true;
  $("#login-panel").hidden = true;
  $("#password-reset-panel").hidden = true;
  $("#register-panel").hidden = false;
  const providerNames = user.full_name.split(/\s+/, 2);
  $("#register-first-name").value = user.first_name || providerNames[0] || "";
  $("#register-last-name").value = user.last_name || providerNames[1] || "";
  $("#register-email").value = user.email;
  $("#register-email").readOnly = true;
  $("#register-username").value = user.username || "";
  $("#register-phone").value = user.phone_number || "";
  $("#register-password-confirm").closest(".form-field").hidden = true;
  $("#register-password-confirm").required = false;
  $("#register-password").closest(".form-field").hidden = true;
  $("#register-password").required = false;
  $("#register-form button[type='submit']").innerHTML =
    'Complete profile <span aria-hidden="true">→</span>';
  $(".auth-story h1").textContent = "Complete your profile.";
  $(".auth-story-intro > p").textContent =
    "Add your interests and preferences so people and communities can get to know you.";
  $("#register-panel .form-heading .section-kicker").textContent = "PROFILE SETUP";
  $("#register-panel .form-heading h2").textContent = "A few details about you";
  $("#register-panel .form-heading > p").textContent =
    "Choose your interests and how you’d like to take part.";
  setTagValues("interests", user.interests || []);
  setTagValues("learning_goals", user.learning_goals || (user.learning_goal ? [user.learning_goal] : []));
  setTagValues("skills_to_share", user.skills_to_share || []);
  setTagValues("languages", user.languages || (user.language ? [user.language] : []));
  $("#register-location").value = user.location || "";
  $("#register-location").dataset.selectedCountry = user.location || "";
  $("#register-bio").value = user.bio || "";
  const role = user.role || "learner";
  $(`#register-form input[name="role"][value="${role}"]`).checked = true;
  updateRegisterRoleFields(role);
  $("#register-form").scrollIntoView({ behavior: "instant", block: "start" });
}

function fillProfileEditor(user) {
  const form = $("#edit-profile-form");
  if (!form) return;
  $(`input[name="role"][value="${user.role}"]`, form).checked = true;
  form.elements.first_name.value = user.first_name || user.full_name.split(/\s+/, 2)[0] || "";
  form.elements.last_name.value = user.last_name || user.full_name.split(/\s+/, 2)[1] || "";
  form.elements.username.value = user.username || "";
  setTagValues("interests", user.interests || [], form);
  setTagValues("skills_to_share", user.skills_to_share || [], form);
  setTagValues("learning_goals", user.learning_goals || (user.learning_goal ? [user.learning_goal] : []), form);
  setTagValues("languages", user.languages || (user.language ? [user.language] : []), form);
  document.querySelectorAll('input[name="learning_style"]', form).forEach(input => {
    input.checked = input.value === user.learning_style;
  });
  form.elements.location.value = user.location;
  form.elements.bio.value = user.bio;
  $("#edit-share-skills-field").hidden = user.role === "learner";
}

function switchAppView(viewName) {
  const panel = $(`[data-app-panel="${viewName}"]`);
  if (!panel) return;
  document.querySelectorAll("[data-app-panel]").forEach(item => {
    const active = item === panel;
    item.hidden = !active;
    item.classList.toggle("active", active);
  });
  document.querySelectorAll("[data-app-nav]").forEach(button => {
    const active = button.dataset.appNav === viewName;
    button.classList.toggle("active", active);
    if (button.matches(".porta-nav-item")) {
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  });
  const titles = { home: "Home", people: "Search people", learn: "Find a class", communities: "Communities", chats: "Chats", dashboard: "Dashboard & Porta Pay", profile: "Profile" };
  $("#app-page-title").textContent = titles[viewName];
  if (viewName === "profile" && currentUser) fillProfileEditor(currentUser);
  if (viewName === "communities") renderCommunityIdeas();
  if (window.matchMedia("(max-width: 520px)").matches) {
    $("#porta-sidebar").classList.remove("expanded");
    $("#sidebar-toggle").setAttribute("aria-expanded", "false");
  }
}

function renderCommunityIdeas(query = "") {
    const board = $("#community-ideas");
    if (!board || !currentUser) return;
    const interests = [...new Set([...(currentUser.interests || []), ...(currentUser.skills_to_share || [])])];
    const topics = (interests.length ? interests : ["Creative projects", "Languages", "Learning together"]).slice(0, 6);
    const icons = ["✳", "Aa", "◉", "✦", "⌘", "↗"];
    const palettes = ["lilac", "peach", "blue", "mint", "rose", "gold"];
    const normalized = query.trim().toLocaleLowerCase();
    const matches = topics.filter(topic => topic.toLocaleLowerCase().includes(normalized));
    board.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "app-empty-state compact community-no-results";
      appendTextElement(empty, "span", "app-empty-icon", "⌕");
      appendTextElement(empty, "h3", "", "No topic ideas match that search");
      appendTextElement(empty, "p", "", "Try another word or add more interests to your profile.");
      board.append(empty);
      return;
    }
    matches.forEach((topic, index) => {
      const card = document.createElement("article");
      card.className = `community-idea-card idea-${palettes[index % palettes.length]}`;
      const art = appendTextElement(card, "div", "community-idea-art", "");
      appendTextElement(art, "span", "community-idea-glyph", icons[index % icons.length]);
      appendTextElement(art, "span", "community-idea-art-label", "A PORTA COMMUNITY IDEA");
      const content = document.createElement("div");
      content.className = "community-idea-copy";
      appendTextElement(content, "span", "community-idea-tag", "NOT OPEN YET");
      appendTextElement(content, "h3", "", `${topic} people`);
      appendTextElement(content, "p", "", `A future space for people who want to share, practice, and explore ${topic.toLocaleLowerCase()} together.`);
      const button = appendTextElement(content, "button", "community-idea-action", "Explore classes →");
      button.type = "button";
      button.addEventListener("click", () => {
        $("#class-topic").value = topic;
        switchAppView("learn");
        $("#class-topic").focus();
      });
      card.append(content);
      board.append(card);
    });
}

function appendTextElement(parent, tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function showAppMessage(container, message, isError = false) {
  container.replaceChildren();
  const messageElement = appendTextElement(container, "p", isError ? "inline-error" : "app-search-message", message);
  messageElement.setAttribute("role", isError ? "alert" : "status");
}

function renderPeople(people) {
  const results = $("#people-search-results");
  results.replaceChildren();
  if (!people.length) {
    const empty = document.createElement("div");
    empty.className = "app-empty-state compact";
    appendTextElement(empty, "span", "app-empty-icon", "⌕");
    appendTextElement(empty, "h3", "", "No matching members yet");
    appendTextElement(empty, "p", "", "Try another name or username. New Porta profiles will be searchable here.");
    results.append(empty);
    return;
  }
  people.forEach(person => {
    const card = document.createElement("article");
    card.className = "people-result-card";
    appendTextElement(card, "span", "people-result-avatar", profileInitials({ full_name: person.full_name }));
    const details = document.createElement("div");
    details.className = "people-result-details";
    appendTextElement(details, "h3", "", person.full_name);
    appendTextElement(details, "p", "", `@${person.username} · ${person.location} · ${(person.languages || []).join(", ")}`);
    const interests = [...(person.interests || []), ...(person.skills_to_share || [])];
    if (interests.length) appendTextElement(details, "p", "people-result-bio", interests.join(" · "));
    if (person.bio) appendTextElement(details, "p", "people-result-bio", person.bio);
    card.append(details);
    results.append(card);
  });
}

async function searchPeople(query) {
  const results = $("#people-search-results");
  const normalized = query.trim();
  if (normalized.length < 2) {
    showAppMessage(results, "Enter at least 2 characters to search.", true);
    $("#people-search-input").focus();
    return;
  }
  showAppMessage(results, "Searching Porta members…");
  try {
    const { people } = await apiRequest(`/api/people?q=${encodeURIComponent(normalized)}`);
    renderPeople(people);
  } catch (error) {
    showAppMessage(results, error.message, true);
  }
}

const AVATAR_OPTIONS = {
  skin: [
    ["#f7d9bd", "Porcelain"], ["#f0c49d", "Warm beige"], ["#dfa77c", "Golden tan"],
    ["#c8875e", "Caramel"], ["#a96d4f", "Cinnamon"], ["#80513f", "Deep umber"], ["#57372f", "Espresso"],
  ],
  face: [["oval", "Soft oval"], ["round", "Round"], ["heart", "Heart"]],
  eyes: [["bright", "Bright"], ["soft", "Soft"], ["bold", "Bold"], ["wink", "Wink"]],
  expression: [["smile", "Smile"], ["grin", "Big smile"], ["calm", "Calm"], ["laugh", "Laugh"]],
  hair: [["curls", "Curls"], ["waves", "Waves"], ["bob", "Bob"], ["locs", "Locs"], ["braids", "Braids"], ["crop", "Crop"], ["headwrap", "Headwrap"]],
  hairColor: [
    ["#282330", "Midnight"], ["#50352c", "Chestnut"], ["#85533a", "Cocoa"], ["#be7849", "Copper"],
    ["#d9ad6d", "Honey"], ["#746985", "Smoky lilac"], ["#bb6676", "Berry"],
  ],
  accessory: [["none", "No extras"], ["glasses", "Round glasses"], ["shades", "Sunglasses"], ["earrings", "Earrings"], ["freckles", "Freckles"]],
  outfit: [["crew", "Crewneck"], ["hoodie", "Hoodie"], ["collar", "Collar"], ["jacket", "Jacket"], ["scarf", "Scarf"]],
  outfitColor: [
    ["#735ee5", "Porta violet"], ["#ee9078", "Coral"], ["#438b82", "Sea glass"], ["#5274bb", "Cobalt"],
    ["#dbad53", "Marigold"], ["#be7190", "Rose"], ["#39465a", "Slate"], ["#f2ede5", "Cloud"],
  ],
  background: [
    ["#eee9ff", "Lavender"], ["#ffede6", "Peach"], ["#dff2eb", "Mint"], ["#e4efff", "Sky"],
    ["#f8edca", "Butter"], ["#f5e3ee", "Blush"], ["#273042", "Midnight"],
  ],
};

const AVATAR_DEFAULTS = Object.freeze({
  skin: "#f0c49d",
  face: "oval",
  eyes: "bright",
  expression: "smile",
  hair: "curls",
  hairColor: "#282330",
  accessory: "none",
  outfit: "crew",
  outfitColor: "#735ee5",
  background: "#eee9ff",
});

function readAvatarStyle() {
  const raw = localStorage.getItem(avatarStorageKey(AVATAR_STYLE_KEY));
  if (!raw) return { ...AVATAR_DEFAULTS };
  try {
    const value = JSON.parse(raw);
    for (const [key, choices] of Object.entries(AVATAR_OPTIONS)) {
      if (!choices.some(([option]) => option === value[key])) return { ...AVATAR_DEFAULTS };
    }
    return Object.fromEntries(Object.keys(AVATAR_DEFAULTS).map(key => [key, value[key]]));
  } catch {
    $("#avatar-feedback").textContent = "Your saved avatar settings could not be read. Create a new look to replace them.";
    return { ...AVATAR_DEFAULTS };
  }
}

function makeAvatarSvg(style) {
  const safeStyle = Object.fromEntries(Object.keys(AVATAR_DEFAULTS).map(key => {
    const value = style[key];
    const choices = AVATAR_OPTIONS[key];
    return [key, choices.some(([option]) => option === value) ? value : AVATAR_DEFAULTS[key]];
  }));
  const skin = safeStyle.skin;
  const hair = safeStyle.hairColor;
  const shirt = safeStyle.outfitColor;
  const facePaths = {
    oval: "M200 98c-61 0-94 49-92 119 2 70 40 111 92 111s90-41 92-111c2-70-31-119-92-119z",
    round: "M200 103c-66 0-100 45-98 113 2 70 42 108 98 108s96-38 98-108c2-68-32-113-98-113z",
    heart: "M200 103c-54-22-98 17-93 94 4 67 40 116 93 135 53-19 89-68 93-135 5-77-39-116-93-94z",
  };
  const hairShapes = {
    curls: "M101 204c-22-31-15-71 12-82-2-34 22-54 51-45 16-30 58-29 73-4 31-18 65 4 61 34 28 17 26 51 2 72l-10 37-21-24-16-36-27 4-27-17-24 17-28-2-24 43z",
    waves: "M103 202c-22-60 4-111 57-119 47-9 101-3 129 27 26 28 20 62 5 93l-18 27-17-36-26-13-25 14-28-16-25 16-23-7-27 43z",
    bob: "M103 200c-17-68 18-119 97-119s114 51 97 119l-9 100h-38l-11-48-39-19-39 19-11 48h-38z",
    locs: "M100 195c-19-57 3-106 53-118 43-28 102-7 124 27 20 31 12 69-2 94l-8 125h-32l4-111-19 111h-30l8-119-22 7-6 112h-31l4-118-22 8-7 104h-31z",
    braids: "M100 192c-15-68 20-111 100-111s115 43 100 111l-10 139h-32l-6-151-21-11-18 11-21-11-19 13-20-12-18 10-17-8-9 159h-32z",
    crop: "M104 181c-7-63 26-100 96-100s103 37 96 100l-22 25-17-22-25 11-22-15-22 14-21-10-26 16-19-8-18 28z",
    headwrap: "M101 208c-15-69 6-124 55-139 48-17 111-3 136 40 15 26 12 63-1 91l-13 108h-37l-8-137-25 15-23-15-21 14-25-12-16 135h-37z",
  };
  const hairFringe = {
    curls: "M106 178c12-59 52-80 94-80 43 0 83 21 94 80-32-8-55-24-72-49-25 30-62 46-116 49z",
    waves: "M105 174c15-52 49-76 95-76 48 0 82 24 95 76-35-5-66-22-91-52-23 30-56 47-99 52z",
    bob: "M107 167c14-52 45-78 93-78 50 0 80 26 93 78-38-9-66-31-85-64-25 35-58 56-101 64z",
    locs: "M107 163c17-51 49-76 93-76 45 0 77 25 93 76-37-7-66-29-91-62-25 33-57 55-95 62z",
    braids: "M107 164c15-51 47-76 93-76s78 25 93 76c-38-6-69-27-93-61-24 34-55 55-93 61z",
    crop: "M108 170c14-48 43-72 92-72s78 24 92 72c-37-6-64-21-92-49-27 28-55 43-92 49z",
    headwrap: "",
  };
  const outfitDetails = {
    crew: `<path d="M162 297c7 25 20 37 38 37s31-12 38-37" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="8"/>`,
    hoodie: `<path d="M157 298c0-30 17-47 43-47s43 17 43 47l-22 22h-42z" fill="#fff" fill-opacity=".15"/><path d="M183 325v39m34-39v39" stroke="#fff" stroke-opacity=".45" stroke-width="5" stroke-linecap="round"/>`,
    collar: `<path d="m163 294 37 51 37-51-24-10h-26z" fill="#fff" fill-opacity=".9"/><path d="m194 329 6 11 6-11-6-8z" fill="#ee9078"/>`,
    jacket: `<path d="m162 292 38 53 38-53-23-10h-30z" fill="#fff" fill-opacity=".22"/><path d="m200 345-13 55h26z" fill="#fff" fill-opacity=".19"/>`,
    scarf: `<path d="M163 294c7 24 20 36 37 36s30-12 37-36l-20-10h-34z" fill="#fff" fill-opacity=".35"/><path d="M187 321c3 28 1 55-8 79l21-16 21 16c-12-37-14-61-11-79z" fill="#fff" fill-opacity=".55"/>`,
  };
  const face = facePaths[safeStyle.face];
  const outfit = outfitDetails[safeStyle.outfit];
  const eyebrows = safeStyle.eyes === "bold"
    ? `<path d="M143 191q20-15 41 0m34 0q21-15 41 0" fill="none" stroke="${hair}" stroke-width="8" stroke-linecap="round"/>`
    : `<path d="M146 197q17-8 34 0m40 0q17-8 34 0" fill="none" stroke="${hair}" stroke-width="5" stroke-linecap="round"/>`;
  const eyeColor = safeStyle.eyes === "soft" ? "#6e716f" : "#493c4a";
  const hairColor = safeStyle.hair === "headwrap" ? shirt : hair;
  const hairBack = `<path d="${hairShapes[safeStyle.hair]}" fill="${hairColor}"/>`;
  const hairTop = safeStyle.hair === "headwrap"
    ? `<path d="M105 177c14-64 46-94 95-94s81 30 95 94c-36-12-68-37-95-72-27 35-59 60-95 72z" fill="${shirt}"/><path d="M137 123c19 23 40 35 63 36 23-1 44-13 63-36" fill="none" stroke="#fff" stroke-opacity=".33" stroke-width="9" stroke-linecap="round"/>`
    : `<path d="${hairFringe[safeStyle.hair]}" fill="${hair}"/>`;
  const hairDetails = safeStyle.hair === "curls"
    ? `<g fill="#fff" fill-opacity=".36"><circle cx="127" cy="102" r="7"/><circle cx="167" cy="83" r="7"/><circle cx="211" cy="79" r="7"/><circle cx="252" cy="99" r="7"/></g>`
    : safeStyle.hair === "waves" || safeStyle.hair === "braids"
      ? `<path d="M126 115c15 25 17 48 7 69m42-78c12 23 13 49 3 73m44-73c11 23 11 49 1 72m42-61c8 19 6 34-3 48" fill="none" stroke="#fff" stroke-opacity=".19" stroke-width="7" stroke-linecap="round"/>`
      : "";
  const accessoryMarkup = {
    none: "",
    glasses: `<g fill="none" stroke="#463a4d" stroke-width="6"><circle cx="163" cy="216" r="23"/><circle cx="237" cy="216" r="23"/><path d="M186 214h28"/></g>`,
    shades: `<g fill="#403849" fill-opacity=".9" stroke="#302c3b" stroke-width="5"><path d="M137 198h51l-4 28c-3 16-36 18-42 0z"/><path d="M212 198h51l-5 28c-5 18-38 16-42 0z"/><path d="M188 206h24"/></g><path d="M146 204h34m41 0h33" stroke="#fff" stroke-opacity=".36" stroke-width="4"/>`,
    earrings: `<g fill="#f3c66f" stroke="#fff0c8" stroke-width="3"><circle cx="105" cy="252" r="8"/><circle cx="295" cy="252" r="8"/></g>`,
    freckles: `<g fill="#9b604a"><circle cx="143" cy="246" r="3"/><circle cx="154" cy="252" r="3"/><circle cx="165" cy="247" r="3"/><circle cx="235" cy="247" r="3"/><circle cx="246" cy="252" r="3"/><circle cx="257" cy="246" r="3"/></g>`,
  }[safeStyle.accessory];
  const mouth = {
    smile: `<path d="M178 266c13 14 31 14 44 0" fill="none" stroke="#9d5158" stroke-width="6" stroke-linecap="round"/>`,
    grin: `<path d="M169 257c17 25 45 25 62 0-3 28-59 37-62 0z" fill="#fff" stroke="#9d5158" stroke-width="4" stroke-linejoin="round"/>`,
    calm: `<path d="M182 266h36" fill="none" stroke="#9d5158" stroke-width="5" stroke-linecap="round"/>`,
    laugh: `<path d="M169 255c18 39 44 39 62 0-2 45-60 47-62 0z" fill="#7b3e48"/><path d="M179 264h42v9h-42z" fill="#fff"/>`,
  }[safeStyle.expression];
  const eyeDetails = {
    bright: `<ellipse cx="163" cy="216" rx="12" ry="15" fill="#36283a"/><ellipse cx="237" cy="216" rx="12" ry="15" fill="#36283a"/><circle cx="167" cy="211" r="4" fill="#fff"/><circle cx="241" cy="211" r="4" fill="#fff"/>`,
    soft: `<path d="M148 217c8-13 24-13 32 0-8 12-24 12-32 0m42 0c8-13 24-13 32 0-8 12-24 12-32 0" fill="#fff" stroke="#48343b" stroke-width="4"/><circle cx="164" cy="217" r="7" fill="#48343b"/><circle cx="206" cy="217" r="7" fill="#48343b"/>`,
    bold: `<ellipse cx="163" cy="217" rx="15" ry="18" fill="#fff"/><ellipse cx="237" cy="217" rx="15" ry="18" fill="#fff"/><ellipse cx="166" cy="218" rx="9" ry="12" fill="#403244"/><ellipse cx="234" cy="218" rx="9" ry="12" fill="#403244"/><circle cx="169" cy="213" r="3.5" fill="#fff"/><circle cx="237" cy="213" r="3.5" fill="#fff"/>`,
    wink: `<ellipse cx="163" cy="216" rx="12" ry="15" fill="#36283a"/><circle cx="167" cy="211" r="4" fill="#fff"/><path d="M218 218c11-11 24-11 36 0" fill="none" stroke="#48343b" stroke-width="5" stroke-linecap="round"/>`,
  }[safeStyle.eyes];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-label="Custom illustrated Porta avatar">
    <circle cx="200" cy="200" r="200" fill="${safeStyle.background}"/>
    <circle cx="200" cy="190" r="154" fill="#fff" fill-opacity=".2"/>
    <path d="M48 400c8-77 61-116 152-116s144 39 152 116z" fill="${shirt}"/>
    ${outfit}
    <path d="M179 281h42v54h-42z" fill="${skin}"/>
    ${hairBack}
    <ellipse cx="107" cy="235" rx="15" ry="23" fill="${skin}"/><ellipse cx="293" cy="235" rx="15" ry="23" fill="${skin}"/>
    <path d="${face}" fill="${skin}"/>
    <path d="M110 181c3-52 30-82 90-82s87 30 90 82" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="4"/>
    ${hairTop}${hairDetails}
    <path d="M105 190c0-70 34-102 95-102s95 32 95 102v45c0 75-40 118-95 118s-95-43-95-118z" fill="${skin}" opacity=".001"/>
    ${eyebrows}
    <g fill="${eyeColor}">${eyeDetails}</g>
    <path d="M200 225c-4 13-7 22-4 26 3 3 7 4 11 2" fill="none" stroke="#a96e56" stroke-width="4" stroke-linecap="round"/>
    ${mouth}
    <ellipse cx="141" cy="252" rx="14" ry="7" fill="#e99588" opacity=".32"/><ellipse cx="259" cy="252" rx="14" ry="7" fill="#e99588" opacity=".32"/>
    ${accessoryMarkup}
    ${safeStyle.hair === "headwrap" ? "" : `<path d="M106 176c14-58 46-83 94-83s80 25 94 83" fill="none" stroke="${hair}" stroke-width="8" stroke-linecap="round"/>`}
  </svg>`;
}

function renderAvatarOptions() {
  const targetMap = {
    skin: "#avatar-skin-options", face: "#avatar-face-options", eyes: "#avatar-eye-options",
    expression: "#avatar-expression-options", hair: "#avatar-hair-options",
    hairColor: "#avatar-hair-color-options", accessory: "#avatar-accessory-options",
    outfit: "#avatar-outfit-options", outfitColor: "#avatar-outfit-color-options",
    background: "#avatar-background-options",
  };
  for (const [key, target] of Object.entries(targetMap)) {
    const container = $(target);
    container.replaceChildren();
    const swatches = ["skin", "hairColor", "outfitColor", "background"].includes(key);
    for (const [value, label] of AVATAR_OPTIONS[key]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = swatches ? "avatar-swatch" : "avatar-choice-button";
      button.dataset.avatarKey = key;
      button.dataset.avatarValue = value;
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(activeAvatarStyle[key] === value));
      if (swatches) {
        button.style.setProperty("--swatch-color", value);
        button.title = label;
      } else {
        const glyphs = { oval: "◯", round: "○", heart: "♡", bright: "◉", soft: "◌", bold: "●", wink: "◠", smile: "⌣", grin: "☺", calm: "—", laugh: "☻", curls: "〰", waves: "≈", bob: "⌒", locs: "▥", braids: "≋", crop: "⌁", headwrap: "◒", none: "·", glasses: "◉", shades: "◒", earrings: "✦", freckles: "⁙", crew: "◡", hoodie: "⌒", collar: "◇", jacket: "⌑", scarf: "⌁" };
        appendTextElement(button, "span", "avatar-choice-glyph", glyphs[value] || "✦");
        appendTextElement(button, "span", "avatar-choice-label", label);
      }
      button.addEventListener("click", () => {
        activeAvatarStyle[key] = value;
        renderAvatarOptions();
        renderAccountAvatar(activeAvatarStyle);
        $(`[data-avatar-key="${key}"][data-avatar-value="${value}"]`).focus();
      });
      container.append(button);
    }
  }
}

function renderAccountAvatar(previewStyle = null) {
  const preview = $("#avatar-preview");
  if (!preview) return;
  const containers = [preview, $("#sidebar-user-avatar"), $("#topbar-user-avatar"), $(".profile-avatar", $("#profile-card"))].filter(Boolean);
  const photo = localStorage.getItem(avatarStorageKey(PROFILE_PHOTO_KEY));
  const style = previewStyle || activeAvatarStyle || readAvatarStyle();
  containers.forEach(container => {
    container.replaceChildren();
    if (photo) {
      const image = document.createElement("img");
      image.src = photo;
      image.alt = "Your profile photo";
      container.append(image);
    } else {
      container.innerHTML = makeAvatarSvg(style);
    }
  });
  $("#remove-profile-photo").hidden = !photo;
}

function updateThemeToggle() {
  const button = $("#theme-toggle");
  if (!button) return;
  const dark = document.body.classList.contains("porta-dark");
  button.textContent = dark ? "☼" : "◐";
  button.setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} mode`);
  button.title = `Switch to ${dark ? "light" : "dark"} mode`;
}

function initializePortaApp() {
  const profile = $("#profile");
  if (profile) $("#profile-view-container").append(profile);
  document.querySelectorAll("[data-app-nav]").forEach(button => {
    button.addEventListener("click", () => {
      switchAppView(button.dataset.appNav);
      button.blur();
    });
  });
  $("#sidebar-toggle").addEventListener("click", () => {
    const sidebar = $("#porta-sidebar");
    const expanded = sidebar.classList.toggle("expanded");
    $("#sidebar-toggle").setAttribute("aria-expanded", String(expanded));
    $("#sidebar-toggle").setAttribute("aria-label", expanded ? "Collapse navigation" : "Expand navigation");
    if (!expanded) $("#sidebar-toggle").blur();
  });
  const savedTheme = localStorage.getItem(THEME_KEY);
  document.body.classList.toggle("porta-dark", savedTheme === "dark");
  updateThemeToggle();
  $("#theme-toggle").addEventListener("click", event => {
    const dark = document.body.classList.toggle("porta-dark");
    try {
      localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
      updateThemeToggle();
      if (event.detail > 0) event.currentTarget.blur();
    } catch (error) {
      document.body.classList.toggle("porta-dark", !dark);
      $("#avatar-feedback").textContent = `Could not save your color theme in this browser. ${error.message}`;
    }
  });
  $("#people-search-form").addEventListener("submit", event => {
    event.preventDefault();
    searchPeople($("#people-search-input").value);
  });
  $("#class-search-form").addEventListener("submit", event => {
    event.preventDefault();
    const topic = $("#class-topic").value.trim();
    const language = $("#class-language").value;
    const visibility = new FormData(event.currentTarget).get("visibility");
    const details = [topic && `“${topic}”`, language && `in ${language}`, visibility !== "any" && `${visibility} classes`].filter(Boolean);
    const description = details.length
      ? `No ${details.join(" ")} are listed yet. When members publish matching classes, they’ll appear here.`
      : "There aren’t any listed classes yet. As members start teaching, matching public and private classes will show up here.";
    const empty = $("#class-results .app-empty-state");
    empty.querySelector("p").textContent = description;
  });
  activeAvatarStyle = readAvatarStyle();
  renderAvatarOptions();
  document.querySelectorAll("[data-avatar-mode]").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-avatar-mode]").forEach(tab => {
        const selected = tab === button;
        tab.classList.toggle("active", selected);
        tab.setAttribute("aria-selected", String(selected));
      });
      document.querySelectorAll("[data-avatar-group]").forEach(group => {
        group.hidden = group.dataset.avatarGroup !== button.dataset.avatarMode;
        group.classList.toggle("active", !group.hidden);
      });
    });
  });
  $("#community-search").addEventListener("input", event => renderCommunityIdeas(event.currentTarget.value));
  document.querySelectorAll("[data-community-tab]").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-community-tab]").forEach(tab => {
        const selected = tab === button;
        tab.classList.toggle("active", selected);
        tab.setAttribute("aria-selected", String(selected));
      });
      document.querySelectorAll("[data-community-content]").forEach(content => {
        content.hidden = content.dataset.communityContent !== button.dataset.communityTab;
      });
    });
  });
  $("#avatar-randomize").addEventListener("click", () => {
    for (const [key, options] of Object.entries(AVATAR_OPTIONS)) {
      const available = options.filter(([value]) => value !== activeAvatarStyle[key]);
      const index = new Uint32Array(1);
      crypto.getRandomValues(index);
      activeAvatarStyle[key] = available[index[0] % available.length][0];
    }
    renderAvatarOptions();
    renderAccountAvatar(activeAvatarStyle);
    $("#avatar-feedback").textContent = "A fresh look, just for you. Tweak anything you like.";
  });
  $("#avatar-maker").addEventListener("submit", event => {
    event.preventDefault();
    try {
      localStorage.setItem(avatarStorageKey(AVATAR_STYLE_KEY), JSON.stringify(activeAvatarStyle));
      localStorage.removeItem(avatarStorageKey(PROFILE_PHOTO_KEY));
      activeAvatarStyle = readAvatarStyle();
      renderAccountAvatar();
      $("#avatar-feedback").textContent = "Your illustrated avatar is saved in this browser.";
    } catch (error) {
      $("#avatar-feedback").textContent = `Could not save your avatar in this browser. ${error.message}`;
    }

  });
  $("#profile-photo-upload").addEventListener("change", event => {
    const file = event.currentTarget.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml" || file.size > 2_000_000) {
      $("#avatar-feedback").textContent = "Choose a photo image smaller than 2 MB.";
      event.currentTarget.value = "";
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const image = new Image();
      image.addEventListener("load", () => {
        try {
          const canvas = document.createElement("canvas");
          const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          localStorage.setItem(avatarStorageKey(PROFILE_PHOTO_KEY), canvas.toDataURL("image/jpeg", .82));
          renderAccountAvatar();
          $("#avatar-feedback").textContent = "Your photo is saved in this browser.";
        } catch (error) {
          $("#avatar-feedback").textContent = `Could not save your photo in this browser. ${error.message}`;
        }
      });
      image.addEventListener("error", () => {
        $("#avatar-feedback").textContent = "That image couldn’t be opened. Try another photo.";
      });
      image.src = reader.result;
    });
    reader.addEventListener("error", () => {
      $("#avatar-feedback").textContent = "The photo couldn’t be read. Try another image.";
    });
    reader.readAsDataURL(file);
  });
  $("#remove-profile-photo").addEventListener("click", () => {
    localStorage.removeItem(avatarStorageKey(PROFILE_PHOTO_KEY));
    renderAccountAvatar();
    $("#avatar-feedback").textContent = "Your illustrated avatar is showing again.";
  });
  renderAccountAvatar();
}

function getTagValues(form, name) {
  const container = $(`[data-tag-input][data-name="${name}"]`, form);
  return container ? [...(tagStates.get(container) || [])] : [];
}

function formTagValues(form, values, name) {
  if ($(`[data-tag-input][data-name="${name}"]`, form)) return getTagValues(form, name);
  if (name === "skills_to_share") {
    return (values.get(name) || "").split(",").map(value => value.trim()).filter(Boolean);
  }
  if (name === "languages" && values.get("language")) return [values.get("language")];
  return values.getAll(name);
}

function setTagValues(name, values, form = $("#register-form")) {
  const container = $(`[data-tag-input][data-name="${name}"]`, form);
  const selected = container && tagStates.get(container);
  if (!selected) return;
  selected.splice(0, selected.length, ...values);
  tagRenderers.get(container)?.();
}

function updateRegisterRoleFields(role) {
  const canLearn = role === "learner" || role === "both";
  const canShare = role === "peer_tutor" || role === "both";
  $("#register-goal-field").hidden = !canLearn;
  $("#share-skills-field").hidden = !canShare;
}

function profilePayload(values, form) {
  const firstName = values.get("first_name") || "";
  const lastName = values.get("last_name") || "";
  const interests = formTagValues(form, values, "interests");
  const skills = formTagValues(form, values, "skills_to_share");
  const learningGoals = $(`[data-tag-input][data-name="learning_goals"]`, form)
    ? getTagValues(form, "learning_goals")
    : (values.get("learning_goal") ? [values.get("learning_goal")] : []);
  const languages = formTagValues(form, values, "languages");
  const localPhone = values.get("phone_number");
  const phoneRegion = $("#register-phone-code").value;
  const normalizedPhone = normalizePhoneNumber(localPhone, phoneRegion);
  return {
    ...(firstName ? { first_name: firstName } : {}),
    ...(lastName ? { last_name: lastName } : {}),
    ...(values.get("username") ? { username: values.get("username") } : {}),
    ...(normalizedPhone ? { phone_number: normalizedPhone } : {}),
    role: values.get("role"),
    interests,
    skills_to_share: skills,
    learning_goals: learningGoals,
    learning_goal: learningGoals.join(" · ").slice(0, 300) || values.get("learning_goal") || "",
    learning_style: values.get("learning_style") || "flexible",
    location: values.get("location"),
    languages,
    language: languages[0] || values.get("language") || "English",
    bio: values.get("bio") || "",
  };
}

function saveAuthentication(result) {
  if (!result.access_token || !result.user) {
    throw new Error("Porta returned an incomplete account response. Please try again.");
  }
  localStorage.setItem(TOKEN_KEY, result.access_token);
  currentUser = result.user;
  renderProfile(currentUser);
  window.scrollTo({ top: 0, behavior: "instant" });
}

$("#login-tab").addEventListener("click", () => setAuthMode("login"));
$("#register-tab").addEventListener("click", () => setAuthMode("register"));
$("#forgot-password-link").addEventListener("click", () => showPasswordReset());
$("#back-to-login").addEventListener("click", () => {
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  delete $("#reset-confirm-password").dataset.token;
  $("#password-reset-confirm-form").reset();
  setAuthMode("login");
});
document.querySelectorAll("[data-show-register]").forEach(button => button.addEventListener("click", () => setAuthMode("register")));
document.querySelectorAll("[data-show-login]").forEach(button => button.addEventListener("click", () => setAuthMode("login")));

$("#password-reset-request-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("button[type='submit']", form);
  const feedback = $("#reset-request-feedback");
  button.disabled = true;
  button.textContent = "Sending reset link…";
  feedback.className = "reset-feedback";
  feedback.textContent = "";
  try {
    const result = await apiRequest("/api/auth/password-reset/request", {
      method: "POST",
      body: JSON.stringify({ email: new FormData(form).get("email") }),
    });
    feedback.classList.add("success");
    feedback.textContent = result.message;
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Send reset link <span aria-hidden="true">→</span>';
  }
});

$("#password-reset-confirm-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("button[type='submit']", form);
  const feedback = $("#reset-confirm-feedback");
  const values = new FormData(form);
  const newPassword = values.get("new_password");
  if (newPassword !== values.get("confirm_password")) {
    feedback.textContent = "Those passwords don’t match yet. Please try again.";
    $("#reset-confirm-password").focus();
    return;
  }
  const token = $("#reset-confirm-password").dataset.token;
  if (!token) {
    feedback.textContent = "This reset link is missing. Request a new one.";
    return;
  }
  button.disabled = true;
  button.textContent = "Updating password…";
  feedback.className = "reset-feedback";
  feedback.textContent = "";
  try {
    const result = await apiRequest("/api/auth/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify({ token, new_password: newPassword }),
    });
    localStorage.removeItem(TOKEN_KEY);
    currentUser = null;
    $("body").classList.remove("authenticated");
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    form.reset();
    delete $("#reset-confirm-password").dataset.token;
    setAuthMode("login");
    setAuthFeedback($("#login-feedback"), result.message, "success");
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Save new password <span aria-hidden="true">→</span>';
  }
});

$("#register-form").addEventListener("change", event => {
  if (event.target.name === "role") {
    updateRegisterRoleFields(event.target.value);
  }
});

function validatePasswordConfirmation() {
  const password = $("#register-password");
  const confirmation = $("#register-password-confirm");
  confirmation.setCustomValidity(
    confirmation.value && confirmation.value !== password.value
      ? "Your passwords do not match."
      : "",
  );
}

$("#register-password").addEventListener("input", validatePasswordConfirmation);
$("#register-password-confirm").addEventListener("input", validatePasswordConfirmation);

$("#edit-profile-form").addEventListener("change", event => {
  if (event.target.name === "role") {
    const needsSharingSkill = event.target.value !== "learner";
    $("#edit-share-skills-field").hidden = !needsSharingSkill;
  }
});

$("#register-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("button[type='submit']", form);
  const feedback = $("#register-feedback");
  const values = new FormData(form);
  const role = values.get("role");
  if (!phoneCodesByRegion.size) {
    setAuthFeedback(feedback, "Country calling codes are still loading. Please try again in a moment.");
    return;
  }
  validatePasswordConfirmation();
  const shareSkills = getTagValues(form, "skills_to_share");
  if (role !== "learner" && !shareSkills.length) {
    setAuthFeedback(feedback, "Add at least one skill you would like to share.");
    $("#register-skills-input").focus();
    return;
  }
  const interests = getTagValues(form, "interests");
  if (!interests.length) {
    setAuthFeedback(feedback, "Choose at least one thing you’re curious about.");
    $("#register-interests-input").focus();
    return;
  }
  const languages = getTagValues(form, "languages");
  if (!languages.length) {
    setAuthFeedback(feedback, "Choose at least one language you’re comfortable in.");
    $("#register-languages-input").focus();
    return;
  }
  if (!countries.some(country => country.toLocaleLowerCase() === values.get("location").trim().toLocaleLowerCase())) {
    setAuthFeedback(feedback, "Choose a country from the suggestions.");
    $("#register-location").focus();
    return;
  }
  const payload = oauthProfileCompletion
    ? {
        profile: profilePayload(values, form),
        policies_accepted: values.get("consent") === "on",
      }
    : {
        full_name: `${values.get("first_name")} ${values.get("last_name")}`.trim(),
        email: values.get("email"),
        password: values.get("password"),
        first_name: values.get("first_name"),
        last_name: values.get("last_name"),
        username: values.get("username"),
        policies_accepted: values.get("consent") === "on",
        ...profilePayload(values, form),
      };
  button.disabled = true;
  button.textContent = "Making your profile…";
  setAuthFeedback(feedback);
  try {
    if (oauthProfileCompletion) {
      const result = await apiRequest("/api/auth/me/phone-verification", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      pendingOAuthPhoneVerification = true;
      showRegistrationVerification(result);
    } else {
      const result = await apiRequest("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      showRegistrationVerification(result);
    }
  } catch (error) {
    setAuthFeedback(feedback, error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = oauthProfileCompletion
      ? 'Complete profile <span aria-hidden="true">→</span>'
      : 'Create account <span aria-hidden="true">→</span>';
  }
});

$("#verification-code-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("#verify-code-button");
  const code = new FormData(form).get("code");
  button.disabled = true;
  setAuthFeedback($("#verification-feedback"));
  try {
    const endpoint = pendingOAuthPhoneVerification
      ? "/api/auth/me/phone-verification/confirm"
      : pendingRegistrationStage === "phone"
        ? "/api/auth/register/verify-phone"
        : "/api/auth/register/verify-email";
    const result = await apiRequest(endpoint, {
      method: "POST",
      body: JSON.stringify({ verification_id: pendingRegistrationId, code }),
    });
    if (pendingOAuthPhoneVerification) {
      pendingOAuthPhoneVerification = false;
      oauthProfileCompletion = false;
      resetRegistrationVerification();
      $("#register-first-name").readOnly = false;
      $("#register-last-name").readOnly = false;
      $("#register-email").readOnly = false;
      $("#register-password").closest(".form-field").hidden = false;
      $("#register-password").required = true;
      $("#register-password-confirm").closest(".form-field").hidden = false;
      $("#register-password-confirm").required = true;
      currentUser = result.user;
      renderProfile(currentUser);
      window.scrollTo({ top: 0, behavior: "instant" });
    } else if (pendingRegistrationStage === "phone") {
      showRegistrationVerification({ ...result, verification_id: pendingRegistrationId });
    } else {
      resetRegistrationVerification();
      saveAuthentication(result);
    }
  } catch (error) {
    setAuthFeedback($("#verification-feedback"), error.message);
  } finally {
    button.disabled = false;
  }
});

$("#resend-verification").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  setAuthFeedback($("#verification-feedback"));
  try {
    const result = await apiRequest("/api/auth/register/resend", {
      method: "POST",
      body: JSON.stringify({ verification_id: pendingRegistrationId }),
    });
    setAuthFeedback($("#verification-feedback"), result.message, "success");
    if (result.stage === "email") {
      $("#verification-description").textContent =
        `Enter the 6-digit code we emailed to ${result.email_hint}.`;
    }
    startVerificationResendCooldown(result.resend_after_seconds || 60);
  } catch (error) {
    setAuthFeedback($("#verification-feedback"), error.message);
    const wait = Number(error.message.match(/wait (\d+) seconds/i)?.[1]);
    if (wait) startVerificationResendCooldown(wait);
  } finally {
    button.disabled = false;
  }
});

function closeProfileEditor() {
  $("#edit-profile-form").hidden = true;
  $("#edit-profile-button").hidden = false;
  setAuthFeedback($("#edit-profile-feedback"));
}

$("#edit-profile-button").addEventListener("click", () => {
  fillProfileEditor(currentUser);
  $("#edit-profile-form").hidden = false;
  $("#edit-profile-button").hidden = true;
  $("#edit-share-skills-field").hidden = $("#edit-profile-form").elements.role.value === "learner";
  $("#edit-profile-form").scrollIntoView({ behavior: "smooth", block: "center" });
});
$("#cancel-profile-edit").addEventListener("click", closeProfileEditor);
$("#cancel-profile-edit-link").addEventListener("click", closeProfileEditor);

$("#edit-profile-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("button[type='submit']", form);
  const values = new FormData(form);
  button.disabled = true;
  button.textContent = "Saving your profile…";
  setAuthFeedback($("#edit-profile-feedback"));
  try {
    const result = await apiRequest("/api/auth/me", {
      method: "PUT",
      body: JSON.stringify({ profile: profilePayload(values, form) }),
    });
    currentUser = result.user;
    renderProfile(currentUser);
    closeProfileEditor();
  } catch (error) {
    setAuthFeedback($("#edit-profile-feedback"), error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Save my profile <span aria-hidden="true">→</span>';
  }
});

$("#login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("button[type='submit']", form);
  const values = new FormData(form);
  button.disabled = true;
  button.textContent = "Logging you in…";
  setAuthFeedback($("#login-feedback"));
  try {
    const result = await apiRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: values.get("email"),
        password: values.get("password"),
      }),
    });
    saveAuthentication(result);
  } catch (error) {
    setAuthFeedback($("#login-feedback"), error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Sign in <span aria-hidden="true">→</span>';
  }
});

$("#logout-button").addEventListener("click", async () => {
  let logoutWarning = "";
  try {
    await apiRequest("/api/auth/logout", { method: "POST" });
  } catch (error) {
    logoutWarning = `${error.message} You’re signed out on this device, but Porta couldn’t confirm that the server session was revoked.`;
  } finally {
    localStorage.removeItem(TOKEN_KEY);
    currentUser = null;
    $("body").classList.remove("authenticated");
    setAuthMode("login");
    if (logoutWarning) setAuthFeedback($("#login-feedback"), logoutWarning);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
});

$("#skill-board").addEventListener("click", event => {
  const tile = event.target.closest("[data-skill]");
  if (!tile) return;
  $("#match-goal").value = tile.dataset.skill;
  $("#match-form").requestSubmit();
});

$("#match-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("button[type='submit']", form);
  const resultBox = $("#match-results");
  const goal = $("#match-goal").value.trim();
  if (!goal) {
    resultBox.innerHTML = '<p class="inline-error">Add a skill or learning goal so Porta can find relevant topics.</p>';
    $("#match-goal").focus();
    return;
  }
  button.disabled = true;
  button.textContent = "Finding a starting point…";
  resultBox.innerHTML = '<p class="results-loading">Comparing your interests with Porta learning topics…</p>';
  try {
    const { matches, score_note: scoreNote } = await apiRequest("/api/recommend", {
      method: "POST",
      body: JSON.stringify({ goal, interests: currentUser?.interests ?? [] }),
    });
    if (!matches.length) {
      resultBox.innerHTML = '<p class="inline-error">Nothing quite matched yet. Try a broader topic, like “language,” “technology,” or “design.”</p>';
      return;
    }
    resultBox.innerHTML = `<div class="results-grid">${matches.map((match, index) => `
      <article class="match-card"><div class="match-card-top"><span class="match-icon">${escapeHtml(match.icon)}</span><span class="match-rank">0${index + 1}</span></div>
      <span class="match-category">${escapeHtml(match.category)}</span><h3>${escapeHtml(match.title)}</h3><p>${escapeHtml(match.description)}</p>
      <div class="match-score"><span>Text relevance</span><strong>${Math.round(match.relevance * 100)}%</strong></div></article>`).join("")}</div>
      <p class="score-disclaimer">${escapeHtml(scoreNote)}</p>`;
  } catch (error) {
    resultBox.innerHTML = `<p class="inline-error">${escapeHtml(error.message)}</p>`;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Find my starting points <span aria-hidden="true">→</span>';
  }
});

async function updateCoachStatus() {
  const status = $("#coach-status");
  try {
    const {
      generative_coach_available: available,
      password_reset_available: resetAvailable,
      whatsapp_verification_available: whatsappAvailable,
      google_login_available: googleAvailable,
      linkedin_login_available: linkedinAvailable,
    } = await apiRequest("/api/status");
    status.textContent = available ? "READY" : "SETUP NEEDED";
    status.classList.toggle("available", available);
    status.title = available
      ? "An AI provider is configured."
      : "The generative coach needs an API key. The local ML matcher is available.";
    $("#reset-setup-note").hidden = resetAvailable;
    $("#whatsapp-setup-note").hidden = whatsappAvailable;
    setSocialLoginAvailability("google", googleAvailable);
    setSocialLoginAvailability("linkedin", linkedinAvailable);
    const missingProviders = [
      ...(!googleAvailable ? ["Google"] : []),
      ...(!linkedinAvailable ? ["LinkedIn"] : []),
    ];
    $("#social-setup-note").hidden = missingProviders.length === 0;
    $("#social-setup-note").textContent = missingProviders.length
      ? `${missingProviders.join(" and ")} sign-in ${missingProviders.length === 1 ? "is" : "are"} not connected yet. The Porta administrator needs to add provider credentials to .env and restart the app.`
      : "";
  } catch {
    status.textContent = "OFFLINE";
    status.title = "Could not check AI coach availability.";
    $("#reset-setup-note").hidden = false;
    $("#whatsapp-setup-note").hidden = false;
    setSocialLoginAvailability("google", false);
    setSocialLoginAvailability("linkedin", false);
    $("#social-setup-note").hidden = false;
    $("#social-setup-note").textContent = "Could not check sign-in setup. Try again when Porta is back online.";
  }
}

function setSocialLoginAvailability(provider, available) {
  const link = $(`.social-button[href="/api/auth/${provider}"]`);
  if (!link) return;
  link.classList.toggle("social-unconfigured", !available);
  link.title = available
    ? `Continue with ${provider === "linkedin" ? "LinkedIn" : "Google"}.`
    : `${provider === "linkedin" ? "LinkedIn" : "Google"} sign-in needs setup. Select to see what is missing.`;
}

$("#coach-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("button[type='submit']", form);
  const output = $("#coach-output");
  const goal = $("#coach-goal").value.trim();
  button.disabled = true;
  button.textContent = "Thinking through your goal…";
  output.className = "coach-output";
  output.textContent = "";
  try {
    const { plan } = await apiRequest("/api/coach", {
      method: "POST",
      body: JSON.stringify({ goal }),
    });
    output.textContent = plan;
    output.classList.add("coach-plan");
  } catch (error) {
    output.textContent = error.message;
    output.classList.add("coach-error");
  } finally {
    button.disabled = false;
    button.innerHTML = 'Make me a learning plan <span aria-hidden="true">✦</span>';
  }
});

loadLearningPaths();
updateCoachStatus();
initializePortaApp();

async function restoreSession() {
  const resetToken = new URLSearchParams(location.hash.slice(1)).get("reset");
  if (resetToken) {
    localStorage.removeItem(TOKEN_KEY);
    $("body").classList.remove("authenticated");
    showPasswordReset(resetToken);
    return;
  }
  const oauthCode = new URLSearchParams(location.hash.slice(1)).get("oauth_code");
  if (oauthCode) {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    try {
      const result = await apiRequest("/api/auth/exchange", {
        method: "POST",
        body: JSON.stringify({ code: oauthCode }),
      });
      saveAuthentication(result);
    } catch (error) {
      setAuthMode("login");
      setAuthFeedback($("#login-feedback"), error.message);
    }
    return;
  }
  const authError = new URLSearchParams(location.search).get("auth_error");
  let authErrorMessage = "";
  if (authError) {
    const messages = {
      google_not_configured: "Google sign-in is not set up yet. Ask the Porta administrator to configure it.",
      linkedin_not_configured: "LinkedIn sign-in is not set up yet. Ask the Porta administrator to configure it.",
      oauth_failed: "Sign-in was cancelled or could not be completed. Please try again.",
      oauth_state_mismatch: "Sign-in security check failed. Start again from Porta, using http://localhost:8000, and don’t switch between localhost and 127.0.0.1.",
      google_cancelled: "Google sign-in was cancelled. Try again and approve the sign-in request.",
      linkedin_cancelled: "LinkedIn sign-in was cancelled. Try again and approve the sign-in request.",
      google_app_credentials_invalid: "Google rejected Porta’s OAuth credentials. Check that the Google Client ID and secret belong to the registered Google web app.",
      linkedin_app_credentials_invalid: "LinkedIn rejected Porta’s OAuth credentials. Check that the Client ID and secret belong to the LinkedIn app with OpenID Connect sign-in enabled.",
      google_authorization_expired: "Google’s sign-in code expired or was already used. Start the sign-in again from Porta.",
      linkedin_authorization_expired: "LinkedIn’s sign-in code expired or was already used. Start the sign-in again from Porta.",
      google_redirect_mismatch: "Google rejected Porta’s callback URL. Verify the exact URL in the Google OAuth web app settings.",
      linkedin_redirect_mismatch: "LinkedIn rejected Porta’s callback URL. Verify the exact URL in the LinkedIn app’s Auth settings.",
      google_scope_unavailable: "Google rejected the requested sign-in permissions. Check the OAuth consent screen and enabled scopes.",
      linkedin_scope_unavailable: "LinkedIn rejected the requested permissions. Enable Sign In with LinkedIn using OpenID Connect for the app.",
      google_oauth_error: "Google returned an OAuth error.",
      linkedin_oauth_error: "LinkedIn returned an OAuth error.",
      email_not_verified: "Your provider did not verify your email address. Verify your email with them and try again.",
    };
    const providerErrorCode = new URLSearchParams(location.search).get("oauth_error_code");
    history.replaceState(null, "", location.pathname);
    authErrorMessage = messages[authError] || "Social sign-in could not be completed. Please try again.";
    if (providerErrorCode && messages[authError]) {
      authErrorMessage = `${messages[authError]} Error code: ${providerErrorCode}.`;
    }
  }
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    setAuthMode("login");
    if (authErrorMessage) setAuthFeedback($("#login-feedback"), authErrorMessage);
    return;
  }
  try {
    const { user } = await apiRequest("/api/auth/me");
    currentUser = user;
    renderProfile(user);
  } catch (error) {
    let message;
    if (error.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      message = "Your session expired. Please log in again.";
    } else {
      message = `We couldn’t reconnect to Porta. ${error.message}`;
    }
    setAuthMode("login");
    setAuthFeedback($("#login-feedback"), message);
  }
}

restoreSession();
