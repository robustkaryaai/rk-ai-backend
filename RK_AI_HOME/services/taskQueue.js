// taskQueue.js - In-memory and chat-synced task tracking for RK AI
import { appendChat } from "../memory.js";

// Map: slug -> Array of task objects
// Each task: { id: string, intent: string, prompt: string, status: "queued"|"in_progress"|"completed"|"failed", createdAt: number, completedAt: number, resultFile: string, error: string }
const taskStore = new Map();

function getSlugTasks(slug) {
  if (!taskStore.has(slug)) {
    taskStore.set(slug, []);
  }
  return taskStore.get(slug);
}

/**
 * Register a new task into the queue for a slug.
 * @returns {string} taskId (e.g. "task_172901_a9f")
 */
export function enqueueTask(slug, intent, prompt) {
  const tasks = getSlugTasks(slug);
  const randomSuffix = Math.random().toString(36).substring(2, 6);
  const id = `task_${Date.now().toString().slice(-6)}_${randomSuffix}`;

  const taskObj = {
    id,
    intent,
    prompt: prompt || intent,
    status: "in_progress",
    createdAt: Date.now(),
    completedAt: null,
    resultFile: null,
    error: null
  };

  tasks.unshift(taskObj);
  // Keep last 30 tasks in memory per slug to prevent leaks
  if (tasks.length > 30) {
    tasks.splice(30);
  }

  return id;
}

/**
 * Mark a task as completed with its resulting filename.
 */
export function completeTask(slug, taskId, resultFile = null) {
  const tasks = getSlugTasks(slug);
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.status = "completed";
    task.completedAt = Date.now();
    task.resultFile = resultFile;
  }
}

/**
 * Mark a task as failed.
 */
export function failTask(slug, taskId, error = null) {
  const tasks = getSlugTasks(slug);
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.status = "failed";
    task.completedAt = Date.now();
    task.error = String(error || "Unknown error");
  }
}

/**
 * Get recent tasks for a slug as a readable context summary for Gemini.
 */
export function getTaskStatusContext(slug) {
  const tasks = getSlugTasks(slug);
  if (!tasks || tasks.length === 0) return "";

  const recent = tasks.slice(0, 8);
  const lines = recent.map(t => {
    const timeAgoSec = Math.round((Date.now() - t.createdAt) / 1000);
    let timeStr = `${timeAgoSec}s ago`;
    if (timeAgoSec > 60) {
      timeStr = `${Math.round(timeAgoSec / 60)}m ago`;
    }

    if (t.status === "completed") {
      return `[${t.id}] ${t.intent.toUpperCase()} ("${t.prompt}"): COMPLETED (${t.resultFile || "done"}, ${timeStr})`;
    }
    if (t.status === "failed") {
      return `[${t.id}] ${t.intent.toUpperCase()} ("${t.prompt}"): FAILED (${t.error || "error"}, ${timeStr})`;
    }
    return `[${t.id}] ${t.intent.toUpperCase()} ("${t.prompt}"): IN_PROGRESS (started ${timeStr})`;
  });

  return `\n## Recent Background Tasks & Status:\n${lines.join("\n")}\n`;
}

/**
 * Return raw recent tasks list.
 */
export function getRecentTasks(slug) {
  return (getSlugTasks(slug) || []).slice(0, 10);
}
