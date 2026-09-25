// 与 main 端 user-service.passwordPolicyError 同规则的前端镜像：
// 至少 8 位，且必须同时包含字母和数字。用于表单即时反馈（禁用提交/提示），
// 真正的强制校验仍在服务端（这里只是体验层，不能替代服务端校验）。

export const PASSWORD_POLICY_LABEL = "至少 8 位，含字母和数字";

export function passwordPolicyOk(pw: string): boolean {
  return pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
}
