执行当前阶段任务。完整 workOrder 已注入你的系统提示（含 ⛔ 任务范围硬约束 + 输入/输出路径 + schema hint；分片阶段另含 targetUnits + 切片读取清单 + 依赖签名），按系统提示的 workOrder 工作，完成后输出 WORKER_SUMMARY + TASK_STATUS（TASK_STATUS 为紧凑 JSON，必须是回复最后一段）。
