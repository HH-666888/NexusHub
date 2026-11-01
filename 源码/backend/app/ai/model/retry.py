"""重试与截断处理。

输出被 max_tokens 截断（finish_reason=length）时，加倍预算重试一次；
再截断就按失败返回，不能无限加预算。
"""
