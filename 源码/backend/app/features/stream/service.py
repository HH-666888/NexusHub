"""事件广播。

把 pipeline 产出的事件按 run 分发给订阅者。单 worker 用内存广播；
多 worker 时改成 DB 轮询，对外契约不变。
"""
