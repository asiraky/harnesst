import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

function stat(path) {
    try { return lstatSync(path) } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
    }
}
function canonical(path) {
    if (stat(path)) return realpathSync(path)
    const parent = dirname(path)
    return parent === path ? path : join(canonical(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
}
function inside(parent, child) {
    const rel = relative(parent, child)
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

// Shared by the standalone teardown hook. Never follows workspace symlinks or
// removes an unrelated directory just because Git refused to manage it.
export async function removeWorktree(rootPath, targetPath) {
    const root = canonical(resolve(rootPath))
    const requested = resolve(root, targetPath)
    if (stat(requested)?.isSymbolicLink()) throw new Error(`refusing symlink worktree: ${requested}`)
    const target = canonical(requested)
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const common = canonical(resolve(root, git('rev-parse', '--git-common-dir')))
    if (inside(target, root) || inside(common, target)) throw new Error(`refusing protected directory: ${target}`)
    if (stat(target)) {
        const pointer = join(target, '.git')
        const pointerStat = stat(pointer)
        if (pointerStat) {
            if (!pointerStat.isFile()) throw new Error(`cannot verify worktree ownership: ${target}`)
            const match = /^gitdir: (.+)$/.exec(readFileSync(pointer, 'utf8').trim())
            const admin = match && canonical(resolve(target, match[1]))
            if (!admin || dirname(admin) !== join(common, 'worktrees')) throw new Error(`worktree belongs to another repository: ${target}`)
        } else {
            // A partial removal may have deleted the pointer first. A surviving
            // registration in this repository still proves which checkout it is.
            const registered = git('worktree', 'list', '--porcelain', '-z').split('\0')
                .some(field => field.startsWith('worktree ') && canonical(resolve(field.slice(9))) === target)
            if (!registered) throw new Error(`cannot verify worktree ownership: ${target}`)
        }
        // Verify ownership before Git can remove its administrative entry.
        try { git('worktree', 'remove', '--force', target) } catch (error) {
            console.warn(`worktree-teardown: Git removal failed; finishing verified worktree removal: ${String(error.stderr || error.message).trim()}`)
        }
        // fs.rm unlinks workspace dependency symlinks instead of following them.
        // Bounded retries handle transient writers without hanging teardown.
        await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        if (stat(target)) throw new Error(`worktree was recreated during removal: ${target}; stop its dev processes and retry`)
    }
    git('worktree', 'prune')
}
