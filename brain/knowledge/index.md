# Factory knowledge

Read what bears on your task; don't read everything.

- [quality.md](quality.md): the quality bar, what done means for code
- [box.md](box.md): the VPS, what else lives on it, what must never be touched
- [isolation.md](isolation.md): how agent containers and previews are kept apart
- [lessons.md](lessons.md): mistakes already paid for once
- [gates.md](gates.md): the safety gates, never changed without the founder

Per-project facts are not here: a project's own `knowledge/` folder on the box
is mounted at `/factory/brain/project` in that project's containers only.

The factory repo itself (`omardmv/factory`) documents the pipeline in its
README and `docs/` (`docs/factory-v2.md`: what is built, with file pointers, and
what is still only planned).
