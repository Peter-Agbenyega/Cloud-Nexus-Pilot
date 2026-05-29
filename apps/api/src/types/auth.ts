export interface AuthUser {
  id: string;
  role: "user" | "analyst" | "admin";
  email?: string;
}

export interface AuthContext {
  user: AuthUser;
}
