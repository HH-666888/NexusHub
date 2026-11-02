"""认证接口的请求/响应形状（契约书 §5.1）。

这里只校验"有没有缺、是不是字符串"；业务规则（长度、字符集、强度）
统一在 domain/user.py —— 两边各写一套的话，前端提示与后端裁决迟早不一致。
"""

from app.domain.base import ApiModel
from app.domain.user import User


class RegisterRequest(ApiModel):
    username: str
    password: str
    confirm_password: str


class LoginRequest(ApiModel):
    username: str
    password: str


class UserResponse(ApiModel):
    user: User
