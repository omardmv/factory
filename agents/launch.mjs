// Which image and which extra mounts a project's agent container gets (spec 5b).
// Pure: the caller injects the file check, so tests need no disk.
//   projects.json: "sayra": { ..., "image": "factory-agent-sayra:latest" }  (extends factory-agent)
//   brain/projects/<project>/knowledge/  ->  /factory/brain/project (read-only, only that project's agents)
export const PROJECT_KNOWLEDGE_MOUNT = '/factory/brain/project';
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SAFE_IMAGE = /^[a-z0-9][a-z0-9_./:-]*$/;

// -> { image, mounts: ['host:container:ro', ...] }. Unset, unknown or malformed settings fall back to
// the default image and no extra mount (today's behaviour).
export function launchArgs({ project, projects = {}, defaultImage, brainDir, exists = () => false }) {
  const p = Object.hasOwn(projects, project) ? projects[project] : null;
  const image = p && typeof p.image === 'string' && SAFE_IMAGE.test(p.image) ? p.image : defaultImage;
  const mounts = [];
  if (p && SAFE_NAME.test(project)) {
    const host = `${brainDir}/projects/${project}/knowledge`;
    if (exists(host)) mounts.push(`${host}:${PROJECT_KNOWLEDGE_MOUNT}:ro`);
  }
  return { image, mounts };
}

// the tag self-update builds from brain/projects/<project>/agent.Dockerfile
export const projectImageTag = (project) => `factory-agent-${project}:latest`;
