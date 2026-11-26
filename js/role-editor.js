/* =====================================================================
 * Socratopia v0 · 角色编辑表单校验（纯函数模块）
 * ---------------------------------------------------------------------
 * 20260827：为规避平台侵权风险，把"老师生成"流程重构为：
 *   1. 用户必填：角色名、作品出处；
 *   2. AI 自动生成：开场白、人设、语气、思考等待文案（4 个 textarea 全部 readonly）；
 *   3. 用户可编辑：老师的姓名、对用户的称呼；
 *   4. 不可由用户主动调整：开场白 / 语气风格 / 人设背景 / 思考等待文案（仅可重新生成）。
 * 借此固化编辑流程，避免用户绕过 AI 自行编造可能侵权的人设。
 *
 * 20260914：删除「类型」字段（原创 / 游戏 / 影视剧 / 历史人物 四选一下拉）。
 *   联网与否改由 AI 依据「作品出处」自行判断，前端不再枚举类型：
 *   - 有公开作品 / 史料可查 → 联网只借说话方式特征；
 *   - 用户原创设定 → 直接自创一位风格统一的人物。
 *   历史角色数据里的 type 字段成为无用残留，读取时忽略、不再写回。
 *
 * 本模块只负责"字段格式校验"，不读 DOM、不做重名（重名是业务校验，调用方负责）。
 * ===================================================================== */

/**
 * 校验角色编辑表单，返回 { ok, role?, field?, message? }。
 * - ok=true：role 已规范化，可直接保存；
 * - ok=false：field 是失败字段的 key（name/series/autoFill），message 是给用户的提示。
 *
 * @param {Object} input 字段值（允许 DOM value 原样传入，内部统一 trim）
 * @returns {{ok:true, role:Object} | {ok:false, field:string, message:string}}
 */
export function validateRoleEditor(input) {
  const name = (input.name || "").trim();
  if (!name) return { ok: false, field: "name", message: "请填写角色名" };
  const series = (input.series || "").trim();
  if (!series) return { ok: false, field: "series", message: "请填写作品出处（必填，AI 联网检索风格需用）" };
  const persona = (input.persona || "").trim();
  const voice = (input.voice || "").trim();
  if (!persona && !voice) {
    return { ok: false, field: "autoFill", message: "请先点「✨ AI 自动补全」生成人设与语气（这 4 项不可手动编辑）" };
  }
  const thinkingPhrases = (input.thinkingPhrases || "").split("\n").map((s) => s.trim()).filter(Boolean);
  return {
    ok: true,
    role: {
      name,
      series,
      userAlias: (input.userAlias || "").trim(),
      openingLine: (input.openingLine || "").trim(),
      persona,
      voice,
      thinkingPhrases,
    },
  };
}

/**
 * 拼接给 AI 的"角色线索 + 联网提示"。20260914：类型字段下线后，
 * 是否联网检索交给模型按「出处」自行判断（有公开资料就检索、原创设定就自创）。
 * 20260827：合规加固，强调"模仿风格而非引用原话"。
 *
 * @param {{name:string, series:string, userAlias?:string}} input
 * @returns {{hint:string, onlineHint:string}}
 */
export function buildAutoFillHints(input) {
  const name = (input.name || "").trim();
  const series = (input.series || "").trim();
  const alias = (input.userAlias || "").trim();
  const hint = [
    "角色名：" + name,
    series ? ("出处：" + series) : "",
    alias ? ("称呼：" + alias) : "",
  ].filter(Boolean).join("；");
  const onlineHint = series
    ? "先判断「" + series + "」是否为公开可查的作品 / 史料 / 真实历史人物：" +
      "是，则联网检索其代表性语料，**只借说话方式的特征**，**不引用原话**；" +
      "若是用户原创设定（无公开资料可查），跳过联网，按其名字与出处自创一位风格统一的人物。" +
      "任何情况下都不要声称与原作 / 作者 / 权利方有任何关联。"
    : "若该角色有公开作品 / 史料可查，联网检索其代表性语料并**只借说话方式的特征**、**不引用原话**；否则按其名字自创一位风格统一的人物。";
  return { hint, onlineHint };
}
