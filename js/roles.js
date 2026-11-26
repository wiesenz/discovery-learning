/* =====================================================================
 * 角色域（注册表 + 自定义角色编辑器）
 * 20260906.1 从 app.js 拆出。
 *
 * 边界原则（与 js/group.js 一致）：本模块**不直读宿主状态**。
 * 需要的宿主能力走 deps 注入，角色增删改后需要宿主重绘的部分走 onRolesChanged 回调。
 *
 * 所有权：ROLES（内置 + 自定义合并后的运行时注册表）与 customRoles（持久化到
 * localStorage 的用户自定义角色）都归本模块所有。宿主只经 getRegistry() 只读访问，
 * 不再持有可写引用——这是角色域能"拆完基本零残留"的根本原因。
 * ===================================================================== */
import { APP_CONFIG, ROLE_REGISTRY } from "../config.js";
import { validateRoleEditor, buildAutoFillHints } from "./role-editor.js";

/**
 * @param {object} deps
 * @param {object} deps.els         角色域用到的 DOM 引用（宿主注入子集，非完整 els）
 * @param {object} deps.LS          localStorage 键名表
 * @param {(msg:string)=>void} deps.toast
 * @param {(b:boolean)=>void} deps.setBusy
 * @param {()=>boolean} deps.isBusy  注意是 getter：宿主里 isBusy 是 let，直接传值会捕获快照
 * @param {(text:string)=>object|null} deps.parseRoleJson
 * @param {(e:Error)=>string} deps.friendlyApiError
 * @param {(messages:Array)=>Promise<string>} deps.callAPIWith
 * @param {(name:string)=>string|null} deps.getAvatar
 * @param {()=>void} deps.saveSettings
 * @param {()=>void} deps.updateAvatarPreview
 * @param {()=>void} deps.onRolesChanged 角色增删改后，重绘依赖角色的 UI（消息气泡里的角色名等）
 */
export function createRoles(deps) {
  const {
    els, LS,
    toast, setBusy, isBusy,
    parseRoleJson, friendlyApiError, callAPIWith,
    getAvatar, saveSettings, updateAvatarPreview, onRolesChanged,
    lsSet,               // (key, value, what) => boolean，统一写入入口（配额满时告警而非静默失败）
  } = deps;

  // ---- 角色注册表（本模块私有状态）----
  let ROLES = {};       // { 角色名: {name, series, userAlias, openingLine, persona, voice, thinkingPhrases} }
  let customRoles = []; // 用户自定义角色（localStorage 持久化，随配置备份）

  function loadCustomRoles() {
    try { customRoles = JSON.parse(localStorage.getItem(LS.customRoles)) || []; } catch (e) { customRoles = []; }
    if (!Array.isArray(customRoles)) customRoles = [];
    return customRoles;
  }
  // 20260913：改用宿主注入的 lsSet（统一写入入口）。
  // 此前是 try{setItem}catch(e){} 空吞 —— 配额满时角色根本没落盘，界面却照报「已新建角色」，
  // 刷新后角色消失（还留下孤儿头像继续占配额，让下一次保存也失败）。这与宿主里
  // "写入失败但 UI 报成功" 是同一类问题，宿主那批已修，这里是漏掉的一处。
  function saveCustomRoles() {
    lsSet(LS.customRoles, JSON.stringify(customRoles), "自定义角色");
  }
  function findCustomRole(name) { return customRoles.find((r) => r && r.name === name) || null; }
  function isCustomRole(name) { return !!findCustomRole(name); }

  // 合并内置角色 + 自定义角色（自定义同名时覆盖内置，便于个性化）
  function rebuildRoles() {
    ROLES = Object.assign({}, ROLE_REGISTRY || {});
    loadCustomRoles().forEach((r) => { if (r && r.name) ROLES[r.name] = r; });
  }

  // 角色已从 roles/*.js 通过 ESM import 登记进 ROLE_REGISTRY；自定义角色运行时从 localStorage 合并进来
  async function loadRoles() {
    rebuildRoles();
    if (Object.keys(ROLES).length === 0) {
      throw new Error("没有加载到任何角色。请确认 index.html 里已引入 roles/*.js，且每个文件都调用了 registerRole({...})。");
    }
  }

  function currentRole() { return ROLES[els.roleSelect.value] || {}; }
  function userAlias() { return currentRole().userAlias || "开拓者"; }

  // ---- 初始化角色下拉 ----
  function initRoles() {
    els.roleSelect.innerHTML = "";
    Object.keys(ROLES).forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name; opt.textContent = name + "（" + (ROLES[name].series || "自定义") + "）";
      els.roleSelect.appendChild(opt);
    });
  }
  // 刷新「✎ 编辑 / ✕ 删除」按钮的可用态：仅自定义角色可编辑/删除，内置角色置灰
  function updateRoleButtons() {
    const custom = isCustomRole(els.roleSelect.value);
    if (els.roleEdit) els.roleEdit.disabled = !custom;
    if (els.roleDel) els.roleDel.disabled = !custom;
  }

  // ---- 自定义角色编辑器（用户自行定制角色，运行时生效，无需改代码 / 重新打包）----
  let roleEditMode = "new";        // "new" | "edit"
  let roleEditOriginalName = null; // 编辑模式下的原角色名（改名时用于定位 + 头像迁移）
  // 角色生成区 UI 开关：开发/演示期 = true（默认收起，可展开核对）；
  // 商用时改 false，前端完全不渲染生成区（生成由后端服务器托管，见商用架构决策）。
  const ROLE_GEN_UI_ENABLED = true;

  function openRoleEditor(mode) {
    roleEditMode = mode;
    roleEditOriginalName = (mode === "edit") ? els.roleSelect.value : null;
    const r = (mode === "edit") ? (ROLES[els.roleSelect.value] || {}) : {};
    els.roleEditTitle.textContent = mode === "edit" ? "编辑角色" : "新建角色";
    els.roleEditSub.textContent = mode === "edit"
      ? "修改「" + (r.name || "") + "」的人设 · AI 联网模仿其语言风格，非原著角色"
      : "指定一位老师，AI 将联网模仿其语言风格作为授课人设（非原著角色）";
    els.roleEditName.value = r.name || "";
    els.roleEditSeries.value = r.series || "";
    els.roleEditAlias.value = r.userAlias || "";
    els.roleEditOpening.value = r.openingLine || "";
    els.roleEditPersona.value = r.persona || "";
    els.roleEditVoice.value = r.voice || "";
    els.roleEditThinking.value = (r.thinkingPhrases || []).join("\n");
    els.roleEditModal.classList.remove("hidden");
    // 生成区可见性：商用时整体隐藏；开发期默认收起（点击「显示生成细节」展开）
    if (!ROLE_GEN_UI_ENABLED) {
      if (els.roleGenToggle) els.roleGenToggle.classList.add("hidden");
      if (els.roleGenDetails) els.roleGenDetails.classList.add("hidden");
    } else {
      if (els.roleGenToggle) els.roleGenToggle.classList.remove("hidden");
      if (els.roleGenDetails) els.roleGenDetails.classList.add("hidden");
      if (els.roleGenToggle) els.roleGenToggle.textContent = "显示生成细节 ▾";
    }
    setTimeout(() => { if (els.roleEditName) els.roleEditName.focus(); }, 50);
  }
  function closeRoleEditor() { els.roleEditModal.classList.add("hidden"); }

  // 角色重名判定：内置注册表与自定义角色都不能撞（编辑态需排除自己原名）
  // 校验本身零成本，必须在任何联网生成之前跑完，否则用户会白等一轮 AI 才被拒。
  function roleNameClash(name) {
    if (Object.prototype.hasOwnProperty.call(ROLE_REGISTRY, name)) return true;
    return customRoles.some((r) => r && r.name === name && name !== roleEditOriginalName);
  }
  // 校验表单，返回规范化的角色对象；非法返回 null
  // 20260827：校验规则抽到 js/role-editor.js，DOM 副作用（toast + focus）仍在此处理
  // 20260914：「类型」字段下线，fieldMap / 入参里同步摘掉 type
  function roleEditorValidate() {
    const fieldMap = { name: els.roleEditName, series: els.roleEditSeries, autoFill: els.roleAutoFill };
    const result = validateRoleEditor({
      name: els.roleEditName.value,
      series: els.roleEditSeries.value,
      userAlias: els.roleEditAlias.value,
      openingLine: els.roleEditOpening.value,
      persona: els.roleEditPersona.value,
      voice: els.roleEditVoice.value,
      thinkingPhrases: els.roleEditThinking.value,
    });
    if (!result.ok) { toast(result.message); if (fieldMap[result.field]) fieldMap[result.field].focus(); return null; }
    // 重名兜底校验——主校验已在 saveRole 生成前跑过，这里防手动流程绕过
    const name = result.role.name;
    if (roleNameClash(name)) { toast("角色名「" + name + "」已存在，请换一个"); els.roleEditName.focus(); return null; }
    return result.role;
  }

  async function saveRole() {
    const name = (els.roleEditName.value || "").trim();
    const series = (els.roleEditSeries.value || "").trim();
    const alias = (els.roleEditAlias.value || "").trim();
    // 基础校验先行（不依赖 AI，避免无谓联网）
    if (!name) { toast("请填写角色名"); els.roleEditName.focus(); return; }
    if (!series) { toast("请填写作品出处（必填）"); els.roleEditSeries.focus(); return; }
    // 重名校验提前到 AI 生成之前：否则用户要先等一轮联网生成，才被一句「已存在」打回
    if (roleNameClash(name)) { toast("角色名「" + name + "」已存在，请换一个"); els.roleEditName.focus(); return; }
    // AI 字段为空 → 自动在后台生成一次（商业化后此逻辑由后端接管；此处对开发期用户透明）
    const aiEmpty = !( (els.roleEditPersona.value || "").trim() || (els.roleEditVoice.value || "").trim() || (els.roleEditOpening.value || "").trim() || (els.roleEditThinking.value || "").trim() );
    if (aiEmpty) {
      if (!ROLE_GEN_UI_ENABLED) { toast("角色人设需由服务端生成，请联系管理员或等待后端接入"); return; }
      if (!(els.apiKey.value || "").trim()) { toast("保存需 AI 生成人设，请先在 ⚙️ 设置填 API Key，或展开「生成细节」手动生成"); ensureGenDetailsVisible(); return; }
      toast("正在自动生成角色人设…");
      setBusy(true);
      try {
        const gen = await generateRoleFields({ type, name, series, userAlias: alias });
        if (!gen) { toast("AI 生成失败，请展开「生成细节」手动重试"); ensureGenDetailsVisible(); return; }
        applyRoleFields(gen);
      } catch (e) {
        toast("AI 生成失败：" + friendlyApiError(e) + "；可展开「生成细节」手动重试"); ensureGenDetailsVisible(); return;
      } finally { setBusy(false); }
    }
    const role = roleEditorValidate();
    if (!role) return;
    if (roleEditMode === "new") {
      customRoles.push(role);
    } else {
      const idx = customRoles.findIndex((r) => r && r.name === roleEditOriginalName);
      if (idx < 0) { toast("找不到要编辑的角色，可能已被删除"); closeRoleEditor(); return; }
      if (role.name !== roleEditOriginalName) { // 改名：迁移头像到新名字下
        const av = getAvatar(roleEditOriginalName);
        if (av) {
          // 走 lsSet：此前这里连 try 都没有，配额满时会直接抛在 saveRole 里（表现为"点保存没反应"）
          lsSet(LS.avatarPrefix + role.name, av, "角色头像");
          localStorage.removeItem(LS.avatarPrefix + roleEditOriginalName);
        }
      }
      customRoles[idx] = role;
    }
    saveCustomRoles();
    rebuildRoles();
    initRoles();
    els.roleSelect.value = role.name; // 选中刚保存的角色
    saveSettings();
    updateRoleButtons();
    updateAvatarPreview();
    onRolesChanged();
    closeRoleEditor();
    toast((roleEditMode === "new" ? "已新建角色「" : "已保存角色「") + role.name + "」");
  }

  function deleteRole() {
    const name = els.roleSelect.value;
    if (!isCustomRole(name)) { toast("内置角色不可删除，只能删除你自己新建的角色"); return; }
    if (!confirm("删除自定义角色「" + name + "」？该角色的头像也会一并删除。")) return;
    customRoles = customRoles.filter((r) => !(r && r.name === name));
    saveCustomRoles();
    localStorage.removeItem(LS.avatarPrefix + name);
    rebuildRoles();
    initRoles(); // 重绘后浏览器自动落到第一个可用角色
    saveSettings();
    updateRoleButtons();
    updateAvatarPreview();
    onRolesChanged();
    toast("已删除角色「" + name + "」");
  }

  // 「✨ AI 自动补全 / 重新生成」：用已配置的大模型，按角色名 + 出处生成 4 项 AI 字段（开场白 / 人设 / 语气 / 思考）。
  // 20260827：合规加固——强调"模仿其风格而非引用原话"；prompt 已在 config.js 强化；
  // 这 4 个 textarea 已是 readonly，只允许通过本按钮写入。
  // 20260914：不再传「类型」，联网与否由模型按出处自行判断（见 js/role-editor.js）。
  // 与授课核心规则完全解耦——这里只生成「角色侧」内容，教学规则另在 config.js 的 socraticRules 等处。
  // 核心：调用大模型生成 4 项 AI 字段，返回解析后的角色对象或 null（不触碰 DOM，便于保存流程复用）
  async function generateRoleFields({ name, series, userAlias: ua }) {
    const { hint, onlineHint } = buildAutoFillHints({ name, series, userAlias: ua });
    const reply = await callAPIWith([
      { role: "system", content: APP_CONFIG.roleAuthorRules },
      { role: "user", content: "角色线索：" + hint + "\n\n" + onlineHint + "\n\n再据此补齐角色设定，返回严格 JSON。" },
    ], { maxTokens: APP_CONFIG.limits.structuredOutputMaxTok });
    return parseRoleJson(reply);
  }
  // 把生成结果回填到 4 个 readonly 输入框（角色名 / 出处不覆盖，保留用户填的）
  function applyRoleFields(role) {
    if (!role) return;
    if (role.persona) els.roleEditPersona.value = role.persona;
    if (role.voice) els.roleEditVoice.value = role.voice;
    if (role.openingLine) els.roleEditOpening.value = role.openingLine;
    if (role.userAlias && !(els.roleEditAlias.value || "").trim()) els.roleEditAlias.value = role.userAlias;
    if (role.thinkingPhrases && role.thinkingPhrases.length) els.roleEditThinking.value = role.thinkingPhrases.join("\n");
  }
  // 折叠开关
  function toggleGenDetails() {
    if (!els.roleGenDetails) return;
    const nowHidden = els.roleGenDetails.classList.toggle("hidden");
    if (els.roleGenToggle) els.roleGenToggle.textContent = nowHidden ? "显示生成细节 ▾" : "收起生成细节 ▴";
  }
  function ensureGenDetailsVisible() {
    if (!els.roleGenDetails) return;
    els.roleGenDetails.classList.remove("hidden");
    if (els.roleGenToggle) els.roleGenToggle.textContent = "收起生成细节 ▴";
  }
  // 「✨ AI 自动补全 / 重新生成」：展开细节后调用模型生成 4 项 AI 字段
  async function autoFillRole() {
    const name = (els.roleEditName.value || "").trim();
    const series = (els.roleEditSeries.value || "").trim();
    const alias = (els.roleEditAlias.value || "").trim();
    if (!name) { toast("请先填角色名"); els.roleEditName.focus(); return; }
    if (!series) { toast("请输入该角色的作品出处（必填，AI 联网检索风格需用）"); els.roleEditSeries.focus(); return; }
    if (!(els.apiKey.value || "").trim()) { toast("自动补全需要先在 ⚙️ 设置里填 API Key"); return; }
    if (isBusy()) { toast("有请求进行中，请稍候"); return; }
    const hadPrev = !!((els.roleEditPersona.value || "").trim() || (els.roleEditVoice.value || "").trim() || (els.roleEditOpening.value || "").trim() || (els.roleEditThinking.value || "").trim());
    ensureGenDetailsVisible();
    els.roleAutoFill.disabled = true;
    const oldLabel = els.roleAutoFill.textContent;
    els.roleAutoFill.textContent = "生成中…";
    setBusy(true);
    try {
      const role = await generateRoleFields({ name, series, userAlias: alias });
      if (!role) { toast("自动补全结果无法解析，请重试"); return; }
      applyRoleFields(role);
      toast(hadPrev ? "已重新生成 4 项 AI 字段（这 4 项不可手动编辑，可直接保存）" : "已自动补全 4 项 AI 字段（这 4 项不可手动编辑，可直接保存）");
    } catch (e) {
      toast("自动补全失败：" + friendlyApiError(e));
    } finally {
      els.roleAutoFill.disabled = false;
      els.roleAutoFill.textContent = oldLabel;
      setBusy(false);
    }
  }

  return {
    // 只读访问注册表（宿主不要再持有可写引用）
    getRegistry: () => ROLES,
    // 生命周期
    loadRoles, initRoles, updateRoleButtons,
    currentRole, userAlias,
    // 编辑器
    openRoleEditor, closeRoleEditor, saveRole, deleteRole, autoFillRole, toggleGenDetails,
  };
}
