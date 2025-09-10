#!/bin/bash
#
# record-demo.sh — Auto-typing demo for context-pilot screen recordings.
#
# Usage:
#   bash scripts/record-demo.sh setup     # Create fake project + npm link
#   bash scripts/record-demo.sh record    # Auto-type into focused Ghostty window
#
# Requirements:
#   - macOS with Accessibility permission for Ghostty (System Settings > Privacy > Accessibility)
#   - Ghostty window must be focused during "record"
#   - Run "setup" once before your first "record"
#

set -euo pipefail

DEMO_DIR="/tmp/context-pilot-demo"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# ── Helpers ──────────────────────────────────────────────────────────

# Type text with natural, human-like rhythm.
# Variable speeds, micro-pauses, occasional hesitations.
type_text() {
  local text="$1"

  # Escape for AppleScript
  local escaped
  escaped=$(printf '%s' "$text" | sed 's/\\/\\\\/g; s/"/\\"/g')

  osascript <<EOF
    set theText to "$escaped"
    set prevChar to ""
    set charsSinceSpace to 0
    tell application "System Events"
      repeat with i from 1 to length of theText
        set c to character i of theText
        keystroke c

        -- Base delay: human typist with natural variation
        set d to 0.045 + (random number from -0.015 to 0.025)

        -- Natural rhythm adjustments
        if prevChar is in {",", ".", ":", ";", "!", "?"} then
          -- Longer pause after sentence-ending punctuation
          if prevChar is in {".", "!", "?"} then
            set d to 0.15 + (random number from -0.03 to 0.08)
          else
            set d to 0.09 + (random number from -0.02 to 0.04)
          end if
        -- Pause at word boundary
        else if prevChar is " " then
          set d to 0.055 + (random number from -0.01 to 0.03)
          set charsSinceSpace to 0
        -- Occasional micro-hesitation mid-word (thinking)
        else if charsSinceSpace > 6 and (random number from 1 to 10) > 8 then
          set d to 0.12 + (random number from -0.02 to 0.05)
        -- Very slight pause before uppercase at word start
        else if prevChar is " " and c is in {"A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z"} then
          set d to 0.065 + (random number from -0.01 to 0.025)
        -- Common letter combos typed slightly faster
        else if prevChar is in {"t", "h", "i", "n", "s", "e", "a"} and c is in {"e", "h", "n", "d", "r", "t"} then
          set d to 0.035 + (random number from -0.008 to 0.015)
        end if

        -- Ensure minimum delay
        if d < 0.02 then set d to 0.02

        delay d
        set prevChar to c
        set charsSinceSpace to charsSinceSpace + 1
      end repeat
    end tell
EOF
}

# Type a command (more deliberate, careful typing)
type_cmd() {
  local text="$1"
  local escaped
  escaped=$(printf '%s' "$text" | sed 's/\\/\\\\/g; s/"/\\"/g')

  osascript <<EOF
    set theText to "$escaped"
    set prevChar to ""
    tell application "System Events"
      repeat with i from 1 to length of theText
        set c to character i of theText
        keystroke c

        -- Commands typed more deliberately with variation
        set d to 0.055 + (random number from -0.02 to 0.035)

        -- Pause at special chars (/, -, .)
        if c is in {"/", "-", ".", "_"} then
          set d to 0.08 + (random number from -0.015 to 0.04)
        -- Slight pause after space in commands
        else if prevChar is " " then
          set d to 0.07 + (random number from -0.01 to 0.03)
        -- Occasional "double-check" pause mid-command
        else if (random number from 1 to 15) > 13 then
          set d to 0.13 + (random number from -0.02 to 0.05)
        end if

        if d < 0.025 then set d to 0.025
        delay d
        set prevChar to c
      end repeat
    end tell
EOF
}

press_enter() {
  osascript -e 'tell application "System Events" to key code 36'
}

press_down() {
  osascript -e 'tell application "System Events" to key code 125'
}

press_up() {
  osascript -e 'tell application "System Events" to key code 126'
}

press_left() {
  osascript -e 'tell application "System Events" to key code 123'
}

press_right() {
  osascript -e 'tell application "System Events" to key code 124'
}

# Cmd+K — native terminal clear
clear_screen() {
  osascript -e 'tell application "System Events" to keystroke "k" using command down'
}

wait_s() {
  local secs="$1"
  local msg="${2:-waiting}"
  echo "  ⏳ $msg (${secs}s)" >&2
  sleep "$secs"
}

# ── Setup: create large React + TypeScript demo project ──────────────

do_setup() {
  echo "Setting up demo project at $DEMO_DIR ..." >&2

  rm -rf "$DEMO_DIR"
  mkdir -p \
    "$DEMO_DIR/src/types" \
    "$DEMO_DIR/src/stores" \
    "$DEMO_DIR/src/components/dashboard" \
    "$DEMO_DIR/src/components/projects" \
    "$DEMO_DIR/src/components/tasks" \
    "$DEMO_DIR/src/components/auth" \
    "$DEMO_DIR/src/components/ui" \
    "$DEMO_DIR/src/hooks" \
    "$DEMO_DIR/src/services" \
    "$DEMO_DIR/src/lib" \
    "$DEMO_DIR/src/api" \
    "$DEMO_DIR/public"

  # ── package.json ──
  cat > "$DEMO_DIR/package.json" << 'PKGJSON'
{
  "name": "acme-dashboard",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "lint": "eslint .",
    "test": "vitest",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "@tanstack/react-query": "^5.60.0",
    "zustand": "^5.0.0",
    "react-router-dom": "^7.0.0",
    "tailwindcss": "^3.4.0",
    "lucide-react": "^0.400.0",
    "date-fns": "^3.6.0",
    "zod": "^3.23.0",
    "axios": "^1.7.0",
    "clsx": "^2.1.0",
    "react-hook-form": "^7.53.0",
    "@hookform/resolvers": "^3.9.0",
    "sonner": "^1.7.0",
    "framer-motion": "^11.12.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "eslint": "^9.0.0",
    "vitest": "^2.1.0",
    "playwright": "^1.49.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0"
  }
}
PKGJSON

  # ── tsconfig.json ──
  cat > "$DEMO_DIR/tsconfig.json" << 'TSCONFIG'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react-jsx",
    "outDir": "dist",
    "rootDir": "src",
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
TSCONFIG

  # ── tailwind.config.js ──
  cat > "$DEMO_DIR/tailwind.config.js" << 'TAILWIND'
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: { extend: {} },
  plugins: [],
};
TAILWIND

  # ── src/types/index.ts — core domain types ──
  cat > "$DEMO_DIR/src/types/index.ts" << 'EOF'
export type Role = "admin" | "member" | "viewer";
export type ProjectStatus = "active" | "archived" | "draft";
export type Priority = "low" | "medium" | "high" | "urgent";
export type TaskStatus = "todo" | "in_progress" | "review" | "done";
export type NotificationType = "mention" | "assignment" | "deadline" | "comment";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  avatarUrl?: string;
  teamId: string | null;
  createdAt: number;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  memberIds: string[];
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  ownerId: string;
  teamId: string;
  members: string[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  projectId: string;
  assigneeId: string | null;
  reporterId: string;
  labels: string[];
  dueDate: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Comment {
  id: string;
  taskId: string;
  authorId: string;
  content: string;
  createdAt: number;
  editedAt: number | null;
}

export interface Notification {
  id: string;
  type: NotificationType;
  userId: string;
  title: string;
  message: string;
  read: boolean;
  actionUrl: string | null;
  createdAt: number;
}

export interface AppSettings {
  theme: "light" | "dark" | "system";
  sidebarCollapsed: boolean;
  notificationsEnabled: boolean;
  defaultProjectView: "board" | "list" | "timeline";
  compactMode: boolean;
}
EOF

  # ── src/types/api.ts — API request/response types ──
  cat > "$DEMO_DIR/src/types/api.ts" << 'EOF'
import type { Project, Task, User, Team, Comment } from "./index";

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, string[]>;
}

export interface CreateProjectRequest {
  name: string;
  description: string;
  teamId: string;
  tags?: string[];
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  status?: Project["status"];
  tags?: string[];
}

export interface CreateTaskRequest {
  title: string;
  description: string;
  projectId: string;
  assigneeId?: string;
  priority: Task["priority"];
  labels?: string[];
  dueDate?: number;
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  status?: Task["status"];
  priority?: Task["priority"];
  assigneeId?: string | null;
  labels?: string[];
  dueDate?: number | null;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: User;
  token: string;
  expiresAt: number;
}

export interface TaskFilters {
  status?: Task["status"][];
  priority?: Task["priority"][];
  assigneeId?: string;
  projectId?: string;
  search?: string;
}
EOF

  # ── src/stores/app-store.ts — Zustand root store ──
  cat > "$DEMO_DIR/src/stores/app-store.ts" << 'EOF'
import { create } from "zustand";
import type { AppSettings, User } from "../types";

interface AppState {
  currentUser: User | null;
  settings: AppSettings;
  isAuthenticated: boolean;

  setCurrentUser: (user: User | null) => void;
  updateSettings: (settings: Partial<AppSettings>) => void;
  logout: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentUser: null,
  isAuthenticated: false,
  settings: {
    theme: "system",
    sidebarCollapsed: false,
    notificationsEnabled: true,
    defaultProjectView: "board",
    compactMode: false,
  },

  setCurrentUser: (user) => set({ currentUser: user, isAuthenticated: !!user }),
  updateSettings: (updates) =>
    set((state) => ({ settings: { ...state.settings, ...updates } })),
  logout: () => set({ currentUser: null, isAuthenticated: false }),
}));
EOF

  # ── src/stores/project-store.ts — project state ──
  cat > "$DEMO_DIR/src/stores/project-store.ts" << 'EOF'
import { create } from "zustand";
import type { Project } from "../types";

interface ProjectState {
  projects: Project[];
  selectedProjectId: string | null;
  isLoading: boolean;

  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  updateProject: (id: string, updates: Partial<Project>) => void;
  deleteProject: (id: string) => void;
  selectProject: (id: string | null) => void;
  setLoading: (loading: boolean) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  selectedProjectId: null,
  isLoading: false,

  setProjects: (projects) => set({ projects }),
  addProject: (project) =>
    set((state) => ({ projects: [...state.projects, project] })),
  updateProject: (id, updates) =>
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p
      ),
    })),
  deleteProject: (id) =>
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
      selectedProjectId:
        state.selectedProjectId === id ? null : state.selectedProjectId,
    })),
  selectProject: (id) => set({ selectedProjectId: id }),
  setLoading: (isLoading) => set({ isLoading }),
}));
EOF

  # ── src/stores/task-store.ts — task state ──
  cat > "$DEMO_DIR/src/stores/task-store.ts" << 'EOF'
import { create } from "zustand";
import type { Task, TaskStatus } from "../types";

interface TaskState {
  tasks: Task[];
  filters: { status?: TaskStatus[]; assigneeId?: string };
  isLoading: boolean;

  setTasks: (tasks: Task[]) => void;
  addTask: (task: Task) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  moveTask: (id: string, status: TaskStatus) => void;
  deleteTask: (id: string) => void;
  setFilters: (filters: Partial<TaskState["filters"]>) => void;
  setLoading: (loading: boolean) => void;
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  filters: {},
  isLoading: false,

  setTasks: (tasks) => set({ tasks }),
  addTask: (task) =>
    set((state) => ({ tasks: [...state.tasks, task] })),
  updateTask: (id, updates) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id ? { ...t, ...updates, updatedAt: Date.now() } : t
      ),
    })),
  moveTask: (id, status) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id
          ? { ...t, status, updatedAt: Date.now(), completedAt: status === "done" ? Date.now() : null }
          : t
      ),
    })),
  deleteTask: (id) =>
    set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) })),
  setFilters: (filters) =>
    set((state) => ({ filters: { ...state.filters, ...filters } })),
  setLoading: (isLoading) => set({ isLoading }),
}));
EOF

  # ── src/services/api.ts — API client ──
  cat > "$DEMO_DIR/src/services/api.ts" << 'EOF'
import axios from "axios";
import type { ApiError } from "../types/api";

export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? "/api",
  timeout: 10000,
  headers: { "Content-Type": "application/json" },
});

export function setAuthToken(token: string | null): void {
  if (token) {
    apiClient.defaults.headers.common["Authorization"] = `Bearer ${token}`;
  } else {
    delete apiClient.defaults.headers.common["Authorization"];
  }
}

export function isApiError(error: unknown): error is { response: { data: ApiError } } {
  return axios.isAxiosError(error) && !!error.response?.data?.code;
}
EOF

  # ── src/services/auth.ts — auth service ──
  cat > "$DEMO_DIR/src/services/auth.ts" << 'EOF'
import { apiClient, setAuthToken } from "./api";
import type { LoginRequest, LoginResponse } from "../types/api";
import type { User } from "../types";

export async function login(credentials: LoginRequest): Promise<LoginResponse> {
  const { data } = await apiClient.post<LoginResponse>("/auth/login", credentials);
  setAuthToken(data.token);
  localStorage.setItem("auth_token", data.token);
  return data;
}

export async function logout(): Promise<void> {
  try {
    await apiClient.post("/auth/logout");
  } finally {
    setAuthToken(null);
    localStorage.removeItem("auth_token");
  }
}

export async function getCurrentUser(): Promise<User> {
  const { data } = await apiClient.get<User>("/auth/me");
  return data;
}

export function restoreSession(): string | null {
  const token = localStorage.getItem("auth_token");
  if (token) setAuthToken(token);
  return token;
}
EOF

  # ── src/services/projects.ts — project service ──
  cat > "$DEMO_DIR/src/services/projects.ts" << 'EOF'
import { apiClient } from "./api";
import type { Project } from "../types";
import type {
  CreateProjectRequest,
  UpdateProjectRequest,
  PaginatedResponse,
} from "../types/api";

export async function fetchProjects(
  teamId: string,
  page = 1,
): Promise<PaginatedResponse<Project>> {
  const { data } = await apiClient.get(`/teams/${teamId}/projects`, {
    params: { page, pageSize: 20 },
  });
  return data;
}

export async function fetchProject(id: string): Promise<Project> {
  const { data } = await apiClient.get<Project>(`/projects/${id}`);
  return data;
}

export async function createProject(req: CreateProjectRequest): Promise<Project> {
  const { data } = await apiClient.post<Project>("/projects", req);
  return data;
}

export async function updateProject(
  id: string,
  req: UpdateProjectRequest,
): Promise<Project> {
  const { data } = await apiClient.patch<Project>(`/projects/${id}`, req);
  return data;
}

export async function deleteProject(id: string): Promise<void> {
  await apiClient.delete(`/projects/${id}`);
}
EOF

  # ── src/services/tasks.ts — task service ──
  cat > "$DEMO_DIR/src/services/tasks.ts" << 'EOF'
import { apiClient } from "./api";
import type { Task } from "../types";
import type {
  CreateTaskRequest,
  UpdateTaskRequest,
  TaskFilters,
  PaginatedResponse,
} from "../types/api";

export async function fetchTasks(
  projectId: string,
  filters?: TaskFilters,
  page = 1,
): Promise<PaginatedResponse<Task>> {
  const { data } = await apiClient.get(`/projects/${projectId}/tasks`, {
    params: { ...filters, page, pageSize: 50 },
  });
  return data;
}

export async function createTask(req: CreateTaskRequest): Promise<Task> {
  const { data } = await apiClient.post<Task>("/tasks", req);
  return data;
}

export async function updateTask(
  id: string,
  req: UpdateTaskRequest,
): Promise<Task> {
  const { data } = await apiClient.patch<Task>(`/tasks/${id}`, req);
  return data;
}

export async function deleteTask(id: string): Promise<void> {
  await apiClient.delete(`/tasks/${id}`);
}

export async function bulkUpdateTasks(
  ids: string[],
  updates: UpdateTaskRequest,
): Promise<Task[]> {
  const { data } = await apiClient.patch<Task[]>("/tasks/bulk", { ids, ...updates });
  return data;
}
EOF

  # ── src/hooks/useAuth.ts ──
  cat > "$DEMO_DIR/src/hooks/useAuth.ts" << 'EOF'
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../stores/app-store";
import * as authService from "../services/auth";
import type { LoginRequest } from "../types/api";

export function useCurrentUser() {
  const setCurrentUser = useAppStore((s) => s.setCurrentUser);
  return useQuery({
    queryKey: ["currentUser"],
    queryFn: async () => {
      const user = await authService.getCurrentUser();
      setCurrentUser(user);
      return user;
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  const setCurrentUser = useAppStore((s) => s.setCurrentUser);
  return useMutation({
    mutationFn: (credentials: LoginRequest) => authService.login(credentials),
    onSuccess: (data) => {
      setCurrentUser(data.user);
      queryClient.invalidateQueries({ queryKey: ["currentUser"] });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  const logout = useAppStore((s) => s.logout);
  return useMutation({
    mutationFn: () => authService.logout(),
    onSuccess: () => {
      logout();
      queryClient.clear();
    },
  });
}
EOF

  # ── src/hooks/useProjects.ts ──
  cat > "$DEMO_DIR/src/hooks/useProjects.ts" << 'EOF'
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as projectService from "../services/projects";
import { useProjectStore } from "../stores/project-store";
import type { CreateProjectRequest, UpdateProjectRequest } from "../types/api";

export function useProjects(teamId: string) {
  const setProjects = useProjectStore((s) => s.setProjects);
  return useQuery({
    queryKey: ["projects", teamId],
    queryFn: async () => {
      const res = await projectService.fetchProjects(teamId);
      setProjects(res.data);
      return res;
    },
    enabled: !!teamId,
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: ["project", id],
    queryFn: () => projectService.fetchProject(id),
    enabled: !!id,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateProjectRequest) => projectService.createProject(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: UpdateProjectRequest & { id: string }) =>
      projectService.updateProject(id, data),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["project", vars.id] });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => projectService.deleteProject(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });
}
EOF

  # ── src/hooks/useTasks.ts ──
  cat > "$DEMO_DIR/src/hooks/useTasks.ts" << 'EOF'
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as taskService from "../services/tasks";
import { useTaskStore } from "../stores/task-store";
import type { CreateTaskRequest, UpdateTaskRequest, TaskFilters } from "../types/api";

export function useTasks(projectId: string, filters?: TaskFilters) {
  const setTasks = useTaskStore((s) => s.setTasks);
  return useQuery({
    queryKey: ["tasks", projectId, filters],
    queryFn: async () => {
      const res = await taskService.fetchTasks(projectId, filters);
      setTasks(res.data);
      return res;
    },
    enabled: !!projectId,
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTaskRequest) => taskService.createTask(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: UpdateTaskRequest & { id: string }) =>
      taskService.updateTask(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useBulkUpdateTasks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, ...updates }: { ids: string[] } & UpdateTaskRequest) =>
      taskService.bulkUpdateTasks(ids, updates),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });
}
EOF

  # ── src/components/dashboard/Dashboard.tsx ──
  cat > "$DEMO_DIR/src/components/dashboard/Dashboard.tsx" << 'EOF'
import type { Project, Task } from "../../types";

export interface DashboardProps {
  projects: Project[];
  recentTasks: Task[];
  onProjectSelect: (id: string) => void;
  onTaskToggle: (id: string) => void;
  isLoading?: boolean;
}

export function Dashboard({ projects, recentTasks, onProjectSelect, onTaskToggle, isLoading }: DashboardProps) {
  if (isLoading) return <div className="animate-pulse">Loading...</div>;
  return (
    <div className="grid grid-cols-12 gap-6 p-6">
      <div className="col-span-8">
        <h2 className="text-xl font-semibold mb-4">Projects</h2>
        {projects.map((p) => (
          <div key={p.id} className="p-4 rounded-lg border cursor-pointer hover:bg-gray-50" onClick={() => onProjectSelect(p.id)}>
            <h3 className="font-medium">{p.name}</h3>
            <p className="text-sm text-gray-500">{p.description}</p>
          </div>
        ))}
      </div>
      <div className="col-span-4">
        <h2 className="text-xl font-semibold mb-4">Recent Tasks</h2>
        {recentTasks.map((t) => (
          <label key={t.id} className="flex items-center gap-2 p-2">
            <input type="checkbox" checked={t.status === "done"} onChange={() => onTaskToggle(t.id)} />
            <span className={t.status === "done" ? "line-through text-gray-400" : ""}>{t.title}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
EOF

  # ── src/components/projects/ProjectCard.tsx ──
  cat > "$DEMO_DIR/src/components/projects/ProjectCard.tsx" << 'EOF'
import type { Project } from "../../types";

export interface ProjectCardProps {
  project: Project;
  taskCount: number;
  completedCount: number;
  onClick: (id: string) => void;
}

export function ProjectCard({ project, taskCount, completedCount, onClick }: ProjectCardProps) {
  const progress = taskCount > 0 ? Math.round((completedCount / taskCount) * 100) : 0;
  return (
    <div className="p-4 rounded-xl border bg-white shadow-sm hover:shadow-md transition-shadow cursor-pointer" onClick={() => onClick(project.id)}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-lg">{project.name}</h3>
        <span className="text-xs px-2 py-1 rounded-full bg-gray-100">{project.status}</span>
      </div>
      <p className="text-sm text-gray-500 mb-3 line-clamp-2">{project.description}</p>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full" style={{ width: `${progress}%` }} />
        </div>
        <span className="text-xs text-gray-400">{completedCount}/{taskCount}</span>
      </div>
    </div>
  );
}
EOF

  # ── src/components/tasks/TaskList.tsx ──
  cat > "$DEMO_DIR/src/components/tasks/TaskList.tsx" << 'EOF'
import type { Task, User } from "../../types";

export interface TaskListProps {
  tasks: Task[];
  users: Map<string, User>;
  onTaskClick: (id: string) => void;
  onStatusChange: (id: string, status: Task["status"]) => void;
  onAssign: (taskId: string, userId: string | null) => void;
}

export function TaskList({ tasks, users, onTaskClick, onStatusChange, onAssign }: TaskListProps) {
  return (
    <div className="divide-y">
      {tasks.map((task) => {
        const assignee = task.assigneeId ? users.get(task.assigneeId) : null;
        return (
          <div key={task.id} className="flex items-center gap-3 p-3 hover:bg-gray-50 cursor-pointer" onClick={() => onTaskClick(task.id)}>
            <select value={task.status} onChange={(e) => onStatusChange(task.id, e.target.value as Task["status"])} onClick={(e) => e.stopPropagation()} className="text-xs border rounded px-1 py-0.5">
              <option value="todo">To Do</option>
              <option value="in_progress">In Progress</option>
              <option value="review">Review</option>
              <option value="done">Done</option>
            </select>
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{task.title}</p>
              <p className="text-xs text-gray-400">{task.labels.join(", ")}</p>
            </div>
            <span className="text-xs text-gray-500">{assignee?.name ?? "Unassigned"}</span>
          </div>
        );
      })}
    </div>
  );
}
EOF

  # ── src/components/auth/LoginForm.tsx ──
  cat > "$DEMO_DIR/src/components/auth/LoginForm.tsx" << 'EOF'
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLogin } from "../../hooks/useAuth";

const loginSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type LoginFormData = z.infer<typeof loginSchema>;

export interface LoginFormProps {
  onSuccess?: () => void;
  onForgotPassword?: () => void;
}

export function LoginForm({ onSuccess, onForgotPassword }: LoginFormProps) {
  const { register, handleSubmit, formState: { errors } } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  });
  const login = useLogin();

  const onSubmit = async (data: LoginFormData) => {
    await login.mutateAsync(data);
    onSuccess?.();
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 max-w-sm mx-auto">
      <div>
        <label className="block text-sm font-medium mb-1">Email</label>
        <input {...register("email")} type="email" className="w-full border rounded-lg px-3 py-2" />
        {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email.message}</p>}
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Password</label>
        <input {...register("password")} type="password" className="w-full border rounded-lg px-3 py-2" />
        {errors.password && <p className="text-red-500 text-xs mt-1">{errors.password.message}</p>}
      </div>
      <button type="submit" disabled={login.isPending} className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
        {login.isPending ? "Signing in..." : "Sign in"}
      </button>
      {onForgotPassword && <button type="button" onClick={onForgotPassword} className="text-sm text-blue-600 hover:underline">Forgot password?</button>}
    </form>
  );
}
EOF

  # ── src/components/ui/Button.tsx ──
  cat > "$DEMO_DIR/src/components/ui/Button.tsx" << 'EOF'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { clsx } from "clsx";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  isLoading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", isLoading, leftIcon, rightIcon, className, children, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={clsx(
          "inline-flex items-center justify-center font-medium rounded-lg transition-colors",
          { "px-3 py-1.5 text-sm": size === "sm", "px-4 py-2": size === "md", "px-6 py-3 text-lg": size === "lg" },
          { "bg-blue-600 text-white hover:bg-blue-700": variant === "primary" },
          { "bg-gray-100 text-gray-700 hover:bg-gray-200": variant === "secondary" },
          { "text-gray-600 hover:bg-gray-100": variant === "ghost" },
          { "bg-red-600 text-white hover:bg-red-700": variant === "danger" },
          { "opacity-50 cursor-not-allowed": disabled || isLoading },
          className,
        )}
        {...props}
      >
        {isLoading ? <span className="animate-spin mr-2">⏳</span> : leftIcon && <span className="mr-2">{leftIcon}</span>}
        {children}
        {rightIcon && <span className="ml-2">{rightIcon}</span>}
      </button>
    );
  },
);
EOF

  # ── src/components/ui/Modal.tsx ──
  cat > "$DEMO_DIR/src/components/ui/Modal.tsx" << 'EOF'
import { type ReactNode, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: "sm" | "md" | "lg";
}

export function Modal({ isOpen, onClose, title, children, size = "md" }: ModalProps) {
  const handleEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [handleEscape]);

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/50" onClick={onClose} />
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className={`relative bg-white rounded-xl shadow-xl p-6 ${size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-lg"} w-full mx-4`}>
            <h2 className="text-lg font-semibold mb-4">{title}</h2>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
EOF

  # ── src/lib/utils.ts — utility functions ──
  cat > "$DEMO_DIR/src/lib/utils.ts" << 'EOF'
import { clsx, type ClassValue } from "clsx";
import { formatDistanceToNow, format } from "date-fns";

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export function formatRelativeTime(timestamp: number): string {
  return formatDistanceToNow(timestamp, { addSuffix: true });
}

export function formatDate(timestamp: number, pattern = "MMM d, yyyy"): string {
  return format(timestamp, pattern);
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + "...";
}

export function groupBy<T>(items: T[], key: keyof T): Record<string, T[]> {
  return items.reduce(
    (groups, item) => {
      const value = String(item[key]);
      (groups[value] ??= []).push(item);
      return groups;
    },
    {} as Record<string, T[]>,
  );
}

export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
EOF

  # ── src/lib/validators.ts — validation helpers ──
  cat > "$DEMO_DIR/src/lib/validators.ts" << 'EOF'
import { z } from "zod";

export const projectSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  description: z.string().max(500).optional().default(""),
  teamId: z.string().uuid(),
  tags: z.array(z.string().max(30)).max(10).optional(),
});

export const taskSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  description: z.string().max(2000).optional().default(""),
  projectId: z.string().uuid(),
  assigneeId: z.string().uuid().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  labels: z.array(z.string().max(30)).max(10).optional(),
  dueDate: z.number().optional(),
});

export type ProjectFormData = z.infer<typeof projectSchema>;
export type TaskFormData = z.infer<typeof taskSchema>;
EOF

  # ── src/lib/constants.ts — app constants ──
  cat > "$DEMO_DIR/src/lib/constants.ts" << 'EOF'
export const APP_NAME = "Acme Dashboard";
export const API_BASE_URL = import.meta.env.VITE_API_URL ?? "/api";
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
export const ITEMS_PER_PAGE = 20;
export const STALE_TIME = 5 * 60 * 1000; // 5 minutes

export const PRIORITY_COLORS: Record<string, string> = {
  low: "text-gray-500 bg-gray-100",
  medium: "text-blue-600 bg-blue-100",
  high: "text-orange-600 bg-orange-100",
  urgent: "text-red-600 bg-red-100",
};

export const STATUS_LABELS: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  review: "In Review",
  done: "Done",
};
EOF

  # ── Expanded key UI components (realistic, 40-80 lines each) ──

  cat > "$DEMO_DIR/src/components/ui/Sidebar.tsx" << 'SIDEBAREOF'
import { useState } from "react";
import { useAppStore } from "../../stores/app-store";
import { cn } from "../../lib/utils";

interface NavItem {
  label: string;
  icon: string;
  href: string;
  badge?: number;
}

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", icon: "LayoutDashboard", href: "/dashboard" },
  { label: "Projects", icon: "FolderKanban", href: "/projects" },
  { label: "Tasks", icon: "CheckSquare", href: "/tasks", badge: 3 },
  { label: "Team", icon: "Users", href: "/team" },
  { label: "Analytics", icon: "BarChart3", href: "/analytics" },
  { label: "Settings", icon: "Settings", href: "/settings" },
];

export interface SidebarProps {
  className?: string;
}

export function Sidebar({ className }: SidebarProps) {
  const [activeItem, setActiveItem] = useState("/dashboard");
  const collapsed = useAppStore((s) => s.settings.sidebarCollapsed);
  const updateSettings = useAppStore((s) => s.updateSettings);

  return (
    <aside className={cn("flex flex-col h-full bg-gray-900 text-white transition-all", collapsed ? "w-16" : "w-64", className)}>
      <div className="flex items-center justify-between p-4 border-b border-gray-800">
        {!collapsed && <span className="text-lg font-bold">Acme</span>}
        <button onClick={() => updateSettings({ sidebarCollapsed: !collapsed })} className="p-1 rounded hover:bg-gray-800">
          {collapsed ? "→" : "←"}
        </button>
      </div>
      <nav className="flex-1 py-4">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.href}
            onClick={() => setActiveItem(item.href)}
            className={cn(
              "flex items-center w-full gap-3 px-4 py-2.5 text-sm transition-colors",
              activeItem === item.href ? "bg-gray-800 text-white" : "text-gray-400 hover:text-white hover:bg-gray-800/50"
            )}
          >
            <span className="w-5 h-5 shrink-0">{item.icon.charAt(0)}</span>
            {!collapsed && (
              <>
                <span className="flex-1 text-left">{item.label}</span>
                {item.badge && (
                  <span className="px-1.5 py-0.5 text-xs bg-blue-600 rounded-full">{item.badge}</span>
                )}
              </>
            )}
          </button>
        ))}
      </nav>
      <div className="p-4 border-t border-gray-800">
        {!collapsed && <p className="text-xs text-gray-500">v1.0.0</p>}
      </div>
    </aside>
  );
}
SIDEBAREOF

  cat > "$DEMO_DIR/src/components/ui/Header.tsx" << 'HEADEREOF'
import { useAppStore } from "../../stores/app-store";
import { cn } from "../../lib/utils";

export interface HeaderProps {
  title?: string;
  className?: string;
}

export function Header({ title = "Dashboard", className }: HeaderProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const logout = useAppStore((s) => s.logout);

  const toggleTheme = () => {
    const next = settings.theme === "light" ? "dark" : settings.theme === "dark" ? "system" : "light";
    updateSettings({ theme: next });
  };

  return (
    <header className={cn("flex items-center justify-between h-16 px-6 border-b bg-white", className)}>
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-semibold">{title}</h1>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={toggleTheme} className="p-2 rounded-lg hover:bg-gray-100" title={`Theme: ${settings.theme}`}>
          {settings.theme === "dark" ? "🌙" : settings.theme === "light" ? "☀️" : "💻"}
        </button>
        {currentUser && (
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white text-sm font-medium">
              {currentUser.name.charAt(0).toUpperCase()}
            </div>
            <div className="hidden md:block">
              <p className="text-sm font-medium">{currentUser.name}</p>
              <p className="text-xs text-gray-500">{currentUser.role}</p>
            </div>
            <button onClick={logout} className="ml-2 text-xs text-gray-400 hover:text-red-500">
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
HEADEREOF

  cat > "$DEMO_DIR/src/components/ui/SearchBar.tsx" << 'SEARCHEOF'
import { useState, useCallback, useRef, useEffect } from "react";
import { debounce } from "../../lib/utils";

export interface SearchBarProps {
  placeholder?: string;
  onSearch: (query: string) => void;
  debounceMs?: number;
  className?: string;
}

export function SearchBar({ placeholder = "Search...", onSearch, debounceMs = 300, className }: SearchBarProps) {
  const [value, setValue] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const debouncedSearch = useCallback(
    debounce((q: string) => onSearch(q), debounceMs),
    [onSearch, debounceMs],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setValue(newValue);
    debouncedSearch(newValue);
  };

  const handleClear = () => {
    setValue("");
    onSearch("");
    inputRef.current?.focus();
  };

  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeydown);
    return () => document.removeEventListener("keydown", handleKeydown);
  }, []);

  return (
    <div className={`relative ${className ?? ""}`}>
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        placeholder={placeholder}
        className={`w-full pl-9 pr-16 py-2 border rounded-lg text-sm transition-colors ${isFocused ? "border-blue-500 ring-1 ring-blue-500" : "border-gray-300"}`}
      />
      {value ? (
        <button onClick={handleClear} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs">✕</button>
      ) : (
        <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 border rounded px-1.5 py-0.5">⌘K</kbd>
      )}
    </div>
  );
}
SEARCHEOF

  cat > "$DEMO_DIR/src/components/ui/NotificationBell.tsx" << 'BELLEOF'
import { useState, useEffect, useRef } from "react";
import type { Notification } from "../../types";

export interface NotificationBellProps {
  notifications: Notification[];
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
}

export function NotificationBell({ notifications, onMarkRead, onMarkAllRead }: NotificationBellProps) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unreadCount = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setIsOpen(!isOpen)} className="relative p-2 rounded-lg hover:bg-gray-100">
        <span className="text-lg">🔔</span>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white border rounded-xl shadow-lg z-50">
          <div className="flex items-center justify-between p-3 border-b">
            <h3 className="font-semibold text-sm">Notifications</h3>
            {unreadCount > 0 && (
              <button onClick={onMarkAllRead} className="text-xs text-blue-600 hover:underline">Mark all read</button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="p-4 text-sm text-gray-500 text-center">No notifications</p>
            ) : (
              notifications.slice(0, 10).map((n) => (
                <button
                  key={n.id}
                  onClick={() => onMarkRead(n.id)}
                  className={`w-full text-left p-3 border-b last:border-0 hover:bg-gray-50 ${!n.read ? "bg-blue-50" : ""}`}
                >
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{n.message}</p>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
BELLEOF

  cat > "$DEMO_DIR/src/components/ui/Table.tsx" << 'TABLEEOF'
import { useState } from "react";

interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  width?: string;
}

export interface TableProps<T> {
  columns: Column<T>[];
  data: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  className?: string;
}

export function Table<T>({ columns, data, rowKey, onRowClick, emptyMessage = "No data", className }: TableProps<T>) {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const handleSort = (key: string) => {
    if (sortCol === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortCol(key);
      setSortDir("asc");
    }
  };

  const sortedData = sortCol
    ? [...data].sort((a, b) => {
        const av = (a as Record<string, unknown>)[sortCol];
        const bv = (b as Record<string, unknown>)[sortCol];
        const cmp = String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      })
    : data;

  if (data.length === 0) {
    return <div className="p-8 text-center text-gray-500">{emptyMessage}</div>;
  }

  return (
    <div className={`overflow-x-auto ${className ?? ""}`}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-gray-50">
            {columns.map((col) => (
              <th
                key={col.key}
                onClick={col.sortable ? () => handleSort(col.key) : undefined}
                className={`px-4 py-3 text-left font-medium text-gray-600 ${col.sortable ? "cursor-pointer hover:text-gray-900" : ""}`}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.header}
                {sortCol === col.key && <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedData.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b ${onRowClick ? "cursor-pointer hover:bg-gray-50" : ""}`}
            >
              {columns.map((col) => (
                <td key={col.key} className="px-4 py-3">
                  {col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
TABLEEOF

  cat > "$DEMO_DIR/src/components/ui/Dialog.tsx" << 'DIALOGEOF'
import { useEffect, useCallback, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";

export interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  actions?: ReactNode;
  variant?: "default" | "danger";
}

export function Dialog({ isOpen, onClose, title, description, children, actions, variant = "default" }: DialogProps) {
  const handleEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, [isOpen, handleEscape]);

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/50"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            className="relative bg-white rounded-xl shadow-xl max-w-md w-full"
          >
            <div className="p-6">
              <h2 className={`text-lg font-semibold ${variant === "danger" ? "text-red-600" : ""}`}>{title}</h2>
              {description && <p className="mt-2 text-sm text-gray-500">{description}</p>}
              {children && <div className="mt-4">{children}</div>}
            </div>
            {actions && (
              <div className="flex justify-end gap-2 p-4 border-t bg-gray-50 rounded-b-xl">
                {actions}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
DIALOGEOF

  cat > "$DEMO_DIR/src/components/ui/Dropdown.tsx" << 'DROPDOWNEOF'
import { useState, useRef, useEffect, type ReactNode } from "react";

interface DropdownItem {
  label: string;
  value: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
}

export interface DropdownProps {
  trigger: ReactNode;
  items: DropdownItem[];
  onSelect: (value: string) => void;
  align?: "left" | "right";
}

export function Dropdown({ trigger, items, onSelect, align = "left" }: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative inline-block">
      <div onClick={() => setIsOpen(!isOpen)}>{trigger}</div>
      {isOpen && (
        <div className={`absolute top-full mt-1 min-w-[160px] bg-white border rounded-lg shadow-lg z-50 py-1 ${align === "right" ? "right-0" : "left-0"}`}>
          {items.map((item) => (
            <button
              key={item.value}
              disabled={item.disabled}
              onClick={() => { onSelect(item.value); setIsOpen(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                item.disabled ? "opacity-50 cursor-not-allowed" :
                item.danger ? "text-red-600 hover:bg-red-50" :
                "text-gray-700 hover:bg-gray-100"
              }`}
            >
              {item.icon && <span className="w-4 h-4">{item.icon}</span>}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
DROPDOWNEOF

  cat > "$DEMO_DIR/src/components/ui/Badge.tsx" << 'BADGEEOF'
import type { ReactNode } from "react";

type BadgeVariant = "default" | "success" | "warning" | "danger" | "info";

export interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  size?: "sm" | "md";
  dot?: boolean;
  removable?: boolean;
  onRemove?: () => void;
  className?: string;
}

const VARIANT_STYLES: Record<BadgeVariant, string> = {
  default: "bg-gray-100 text-gray-700",
  success: "bg-green-100 text-green-700",
  warning: "bg-yellow-100 text-yellow-700",
  danger: "bg-red-100 text-red-700",
  info: "bg-blue-100 text-blue-700",
};

export function Badge({ children, variant = "default", size = "sm", dot, removable, onRemove, className }: BadgeProps) {
  const sizeClass = size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-medium ${VARIANT_STYLES[variant]} ${sizeClass} ${className ?? ""}`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${variant === "success" ? "bg-green-500" : variant === "danger" ? "bg-red-500" : "bg-gray-500"}`} />}
      {children}
      {removable && (
        <button onClick={onRemove} className="ml-0.5 hover:opacity-70 text-current">
          ✕
        </button>
      )}
    </span>
  );
}
BADGEEOF

  cat > "$DEMO_DIR/src/components/ui/Spinner.tsx" << 'SPINNEREOF'
export interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  label?: string;
  className?: string;
  fullPage?: boolean;
}

const SIZE_MAP = {
  sm: "w-4 h-4 border-2",
  md: "w-8 h-8 border-3",
  lg: "w-12 h-12 border-4",
};

export function Spinner({ size = "md", label, className, fullPage }: SpinnerProps) {
  const spinner = (
    <div className={`flex flex-col items-center gap-3 ${className ?? ""}`}>
      <div className={`${SIZE_MAP[size]} border-blue-600 border-t-transparent rounded-full animate-spin`} />
      {label && <p className="text-sm text-gray-500">{label}</p>}
    </div>
  );

  if (fullPage) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-white/80 z-50">
        {spinner}
      </div>
    );
  }

  return spinner;
}
SPINNEREOF

  # Remaining UI stubs (simple one-line components for realistic noise)
  for f in UserAvatar Tooltip Card Alert Popover Tabs Accordion Pagination Input Select Checkbox Radio Switch TextArea Form FormField Label ErrorMessage; do
    cat > "$DEMO_DIR/src/components/ui/${f}.tsx" << INNEREOF
import type { ReactNode } from "react";
export interface ${f}Props { children?: ReactNode; className?: string; }
export function ${f}({ children, className }: ${f}Props) { return <div className={className}>{children}</div>; }
INNEREOF
  done

  # Add more feature components
  mkdir -p "$DEMO_DIR/src/components/analytics" "$DEMO_DIR/src/components/settings" "$DEMO_DIR/src/components/notifications" "$DEMO_DIR/src/components/team"

  for f in AnalyticsChart MetricsCard RevenueGraph UserActivityTimeline ProjectStats; do
    cat > "$DEMO_DIR/src/components/analytics/${f}.tsx" << INNEREOF
import type { ReactNode } from "react";
export interface ${f}Props { data?: unknown; className?: string; }
export function ${f}({ data, className }: ${f}Props) { return <div className={className}>Analytics Component</div>; }
INNEREOF
  done

  for f in SettingsPanel ProfileSettings TeamSettings BillingSettings SecuritySettings IntegrationSettings NotificationSettings; do
    cat > "$DEMO_DIR/src/components/settings/${f}.tsx" << INNEREOF
import type { ReactNode } from "react";
export function ${f}() { return <div>Settings Component</div>; }
INNEREOF
  done

  for f in NotificationList NotificationItem NotificationPreferences; do
    cat > "$DEMO_DIR/src/components/notifications/${f}.tsx" << INNEREOF
import type { ReactNode } from "react";
export function ${f}() { return <div>Notification Component</div>; }
INNEREOF
  done

  for f in TeamList TeamCard TeamMember InviteModal RoleSelector; do
    cat > "$DEMO_DIR/src/components/team/${f}.tsx" << INNEREOF
import type { ReactNode } from "react";
export function ${f}() { return <div>Team Component</div>; }
INNEREOF
  done

  # Add utility and helper files
  mkdir -p "$DEMO_DIR/src/utils"
  for f in date-helpers string-helpers array-helpers object-helpers validation-helpers storage-helpers api-helpers error-handlers; do
    cat > "$DEMO_DIR/src/utils/${f}.ts" << INNEREOF
export function placeholder() { return true; }
INNEREOF
  done

  # Add more API service files
  for f in analytics teams notifications users comments attachments webhooks integrations; do
    cat > "$DEMO_DIR/src/services/${f}.ts" << INNEREOF
import { apiClient } from "./api";
export async function fetchData() { return apiClient.get("/data"); }
INNEREOF
  done

  # Add test files to increase file count significantly
  mkdir -p "$DEMO_DIR/src/__tests__/components" "$DEMO_DIR/src/__tests__/services" "$DEMO_DIR/src/__tests__/utils"

  for f in Dashboard ProjectCard TaskList LoginForm Button Modal; do
    cat > "$DEMO_DIR/src/__tests__/components/${f}.test.tsx" << INNEREOF
import { describe, it, expect } from "vitest";
describe("${f}", () => { it("renders", () => { expect(true).toBe(true); }); });
INNEREOF
  done

  for f in api auth projects tasks; do
    cat > "$DEMO_DIR/src/__tests__/services/${f}.test.ts" << INNEREOF
import { describe, it, expect } from "vitest";
describe("${f} service", () => { it("works", () => { expect(true).toBe(true); }); });
INNEREOF
  done

  # Add E2E tests
  mkdir -p "$DEMO_DIR/e2e/specs" "$DEMO_DIR/e2e/fixtures"

  for f in login dashboard projects tasks team settings; do
    cat > "$DEMO_DIR/e2e/specs/${f}.spec.ts" << INNEREOF
import { test, expect } from "@playwright/test";
test("${f} works", async ({ page }) => { await page.goto("/"); });
INNEREOF
  done

  # Add fixtures and mock data
  mkdir -p "$DEMO_DIR/src/fixtures"
  for f in users projects tasks teams comments notifications; do
    cat > "$DEMO_DIR/src/fixtures/${f}.ts" << INNEREOF
export const mock${f^} = [{ id: "1", name: "Test" }];
INNEREOF
  done

  # Add more config files
  cat > "$DEMO_DIR/.eslintrc.cjs" << 'ESLINTEOF'
module.exports = { extends: ["eslint:recommended"], rules: {} };
ESLINTEOF

  cat > "$DEMO_DIR/vite.config.ts" << 'VITEEOF'
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()] });
VITEEOF

  cat > "$DEMO_DIR/vitest.config.ts" << 'VITESTEOF'
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "jsdom" } });
VITESTEOF

  cat > "$DEMO_DIR/playwright.config.ts" << 'PLAYWRIGHTEOF'
import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./e2e" });
PLAYWRIGHTEOF

  cat > "$DEMO_DIR/postcss.config.js" << 'POSTCSSEOF'
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
POSTCSSEOF

  # ── Realistic project files (7b) ──

  cat > "$DEMO_DIR/.env.example" << 'ENVEOF'
VITE_API_URL=http://localhost:3001/api
VITE_WS_URL=ws://localhost:3001
VITE_SENTRY_DSN=
VITE_ANALYTICS_ENABLED=false
ENVEOF

  cat > "$DEMO_DIR/.prettierrc" << 'PRETTIEREOF'
{
  "semi": true,
  "singleQuote": false,
  "tabWidth": 2,
  "trailingComma": "all",
  "printWidth": 100
}
PRETTIEREOF

  mkdir -p "$DEMO_DIR/.github/workflows"
  cat > "$DEMO_DIR/.github/workflows/ci.yml" << 'CIEOF'
name: CI
on: [push, pull_request]
jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run lint
      - run: npm test
CIEOF

  mkdir -p "$DEMO_DIR/docs"
  cat > "$DEMO_DIR/docs/seed-data.sql" << 'SQLEOF'
-- Seed data for development
INSERT INTO teams (id, name, slug) VALUES
  ('t1', 'Engineering', 'engineering'),
  ('t2', 'Design', 'design'),
  ('t3', 'Product', 'product');

INSERT INTO users (id, name, email, role, team_id) VALUES
  ('u1', 'Alice Chen', 'alice@acme.co', 'admin', 't1'),
  ('u2', 'Bob Smith', 'bob@acme.co', 'member', 't1'),
  ('u3', 'Carol Davis', 'carol@acme.co', 'member', 't2');

INSERT INTO projects (id, name, description, status, team_id) VALUES
  ('p1', 'Dashboard Redesign', 'Modernize the main dashboard', 'active', 't1'),
  ('p2', 'Mobile App', 'React Native mobile client', 'active', 't1'),
  ('p3', 'Design System', 'Shared component library', 'draft', 't2');
SQLEOF

  cat > "$DEMO_DIR/Dockerfile" << 'DOCKEREOF'
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
DOCKEREOF

  cat > "$DEMO_DIR/src/App.tsx" << 'APPEOF'
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { useAppStore } from "./stores/app-store";
import { Dashboard } from "./components/dashboard/Dashboard";
import { LoginForm } from "./components/auth/LoginForm";
import { Sidebar } from "./components/ui/Sidebar";
import { Header } from "./components/ui/Header";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5 * 60 * 1000, retry: 1 } },
});

function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

export default function App() {
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={isAuthenticated ? <Navigate to="/" /> : <LoginForm />} />
          <Route path="/*" element={
            isAuthenticated ? (
              <AppLayout>
                <Routes>
                  <Route path="/" element={<Dashboard projects={[]} recentTasks={[]} onProjectSelect={() => {}} onTaskToggle={() => {}} />} />
                </Routes>
              </AppLayout>
            ) : <Navigate to="/login" />
          } />
        </Routes>
      </BrowserRouter>
      <Toaster position="bottom-right" />
    </QueryClientProvider>
  );
}
APPEOF

  cat > "$DEMO_DIR/src/main.tsx" << 'MAINEOF'
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { restoreSession } from "./services/auth";
import "./index.css";

restoreSession();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
MAINEOF

  # ── Cleanup (7c): remove any leftover config ──
  rm -f "$DEMO_DIR/.context-pilot.json"

  # Add README and docs
  mkdir -p "$DEMO_DIR/docs"
  cat > "$DEMO_DIR/README.md" << 'READMEEOF'
# Acme Dashboard

A comprehensive project management dashboard built with React, TypeScript, and Tailwind CSS.

## Features
- Project management
- Task tracking
- Team collaboration
- Real-time notifications
- Analytics and reporting

## Tech Stack
- React 18 with TypeScript
- Tailwind CSS for styling
- Zustand for state management
- React Query for server state
- Vite for building
- Vitest + Playwright for testing
READMEEOF

  cat > "$DEMO_DIR/docs/architecture.md" << 'ARCHEOF'
# Architecture

## Directory Structure
- `src/components/` - React components
- `src/services/` - API services
- `src/stores/` - Zustand stores
- `src/hooks/` - Custom React hooks
- `src/types/` - TypeScript types
ARCHEOF

  # ── Create fake node_modules ──
  mkdir -p "$DEMO_DIR/node_modules"

  # ── Remove any leftover IDE config directories ──
  rm -rf "$DEMO_DIR/.cursor" "$DEMO_DIR/.windsurf" 2>/dev/null || true

  # ── Count files for the summary ──
  local file_count
  file_count=$(find "$DEMO_DIR/src" "$DEMO_DIR/e2e" -name "*.ts" -o -name "*.tsx" 2>/dev/null | wc -l | tr -d ' ')

  # ── Link context-pilot globally ──
  echo "" >&2
  echo "Linking context-pilot globally..." >&2
  cd "$PROJECT_DIR"
  npm link --silent 2>/dev/null || npm link

  echo "" >&2
  echo "✅ Setup complete!" >&2
  echo "   Demo project: $DEMO_DIR" >&2
  echo "   Source files: $file_count" >&2
  echo "   Project type: Large React + TypeScript dashboard app" >&2
  echo "   Includes: Components, services, stores, hooks, tests, E2E, docs" >&2
  echo "   context-pilot linked globally" >&2
  echo "" >&2
  echo "This large project is perfect for demonstrating context-pilot's" >&2
  echo "optimization and reduction capabilities!" >&2
  echo "" >&2
  echo "Next steps:" >&2
  echo "  1. Open Ghostty, resize window to ~80x24" >&2
  echo "  2. Start Kap (or Cmd+Shift+5) to record the Ghostty window" >&2
  echo "  3. Focus Ghostty and run:  bash scripts/record-demo.sh record" >&2
}

# ── Record: auto-type into the focused terminal ─────────────────────

do_record() {
  echo "" >&2
  echo "Starting auto-type in 7 seconds..." >&2
  echo "Switch to Ghostty NOW and keep it focused!" >&2
  echo "" >&2

  # Clean up any IDE config / saved state from previous runs
  rm -rf "$DEMO_DIR/.cursor" "$DEMO_DIR/.windsurf" "$DEMO_DIR/CLAUDE.md" "$DEMO_DIR/.aider.conf.yml" 2>/dev/null || true
  rm -f "$DEMO_DIR/.context-pilot.json" 2>/dev/null || true

  sleep 7

  # ── Clear and navigate ──

  clear_screen
  wait_s 0.3 "cleared"

  type_cmd "cd /tmp/context-pilot-demo"
  press_enter
  wait_s 0.4 "cd"

  # ── Run context-pilot ──

  type_cmd "context-pilot"
  press_enter
  wait_s 2.5 "detection"

  # ── 1. IDE selection: browse options then pick Claude Code ──
  # Show we're looking through options, then select Claude Code (index 0)

  wait_s 0.5 "before IDE select"

  # Browse down through a few options
  press_down
  sleep 0.35
  press_down
  sleep 0.35
  press_down
  sleep 0.4

  # Go back up to Claude Code
  press_up
  sleep 0.3
  press_up
  sleep 0.3
  press_up
  sleep 0.35

  press_enter
  wait_s 0.6 "IDE selected"

  # ── 2. Stack confirmation: "Detected: React + ... Correct?" ──

  wait_s 0.3 "before stack confirm"
  press_enter
  wait_s 0.5 "stack confirmed"

  # ── 3. Project purpose ──

  type_text "A React dashboard for managing team projects and tracking tasks"
  wait_s 0.2 "before purpose enter"
  press_enter
  wait_s 0.5 "purpose entered"

  # ── 4. Key patterns ──

  type_text "React Query for server state, Zustand for client state, Tailwind for styling"
  wait_s 0.2 "before patterns enter"
  press_enter
  wait_s 0.5 "patterns entered"

  # ── 5. Gotchas ──

  type_text "No class components, always use TypeScript strict mode"
  wait_s 0.2 "before gotchas enter"
  press_enter
  wait_s 0.5 "gotchas entered"

  # ── 6. Code snapshot: Yes, auto-detect (default) ──

  wait_s 0.3 "before snapshot"
  press_enter
  wait_s 4.5 "snapshot + generation (large project)"

  # ── 7. Overwrite existing context? → Yes ──
  # Default is Yes, just press enter to accept.

  wait_s 0.8 "before overwrite prompt"
  press_enter
  wait_s 1.5 "overwrite processing"

  # ── 8. Done! ──
  # Show final summary

  wait_s 3.5 "final summary visible"

  # ── 9. Optional: Show the generated file ──
  # Uncomment to show file contents at end of demo
  # echo ""
  # type_cmd "head -30 CLAUDE.md"
  # press_enter
  # wait_s 3.0 "showing generated file"

  echo "" >&2
  echo "✅ Recording sequence complete!" >&2
  echo "   Stop your screen recording now." >&2
}

# ── Main ─────────────────────────────────────────────────────────────

case "${1:-}" in
  setup)
    do_setup
    ;;
  record)
    do_record
    ;;
  *)
    echo "Usage: bash $0 {setup|record}" >&2
    echo "" >&2
    echo "  setup   — Create fake demo project + link context-pilot" >&2
    echo "  record  — Auto-type into focused Ghostty window" >&2
    exit 1
    ;;
esac
