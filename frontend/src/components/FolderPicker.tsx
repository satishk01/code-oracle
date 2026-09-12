import { useState, useEffect } from 'react';
import { FolderOpen, X, ArrowUp, HardDrive, Folder, ChevronRight, Check } from 'lucide-react';
import { api } from '../hooks/useApi';

interface BrowseDir {
  name: string;
  path: string;
  hasSubdirs: boolean;
}

export function FolderPicker({ initialPath, onSelect, onClose }: {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [currentPath, setCurrentPath] = useState<string>('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [isRoot, setIsRoot] = useState(false);
  const [dirs, setDirs] = useState<BrowseDir[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  async function loadDirs(targetPath?: string) {
    setLoading(true);
    setError(null);
    try {
      const result = await api.browse(targetPath);
      setCurrentPath(result.path);
      setParentPath(result.parent);
      setIsRoot(result.isRoot);
      setDirs(result.dirs);
      setSelectedPath(result.path || null);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadDirs(initialPath);
  }, []);

  function handleSelect() {
    if (selectedPath) {
      onSelect(selectedPath);
    }
  }

  return (
    <div className="folder-picker-overlay" onClick={onClose}>
      <div className="folder-picker-modal" onClick={e => e.stopPropagation()}>
        <div className="fp-header">
          <FolderOpen size={20} />
          <h2>Select Repository Folder</h2>
          <button className="fp-close" onClick={onClose}><X size={18} /></button>
        </div>

        {/* Breadcrumb / current path */}
        <div className="fp-path-bar">
          <button
            className="fp-up-btn"
            onClick={() => parentPath && loadDirs(parentPath)}
            disabled={!parentPath}
            title="Go up one level"
          >
            <ArrowUp size={16} />
          </button>
          <span className="fp-current-path" title={currentPath}>
            {currentPath || 'Computer'}
          </span>
        </div>

        {/* Directory listing */}
        <div className="fp-listing">
          {loading && <div className="fp-loading">Loading…</div>}
          {error && <div className="fp-error">{error}</div>}
          {!loading && !error && dirs.length === 0 && (
            <div className="fp-empty">No subdirectories found.</div>
          )}
          {!loading && !error && dirs.map(d => (
            <button
              key={d.path}
              className={`fp-dir-item ${selectedPath === d.path ? 'selected' : ''}`}
              onClick={() => setSelectedPath(d.path)}
              onDoubleClick={() => loadDirs(d.path)}
            >
              {isRoot ? <HardDrive size={16} /> : <Folder size={16} />}
              <span className="fp-dir-name">{d.name}</span>
              {d.hasSubdirs && <ChevronRight size={14} className="fp-dir-arrow" />}
            </button>
          ))}
        </div>

        {/* Actions */}
        <div className="fp-actions">
          <span className="fp-selected-path">
            {selectedPath ? selectedPath : 'Select a folder…'}
          </span>
          <div className="fp-btn-group">
            <button className="fp-cancel-btn" onClick={onClose}>Cancel</button>
            <button
              className="fp-select-btn"
              onClick={handleSelect}
              disabled={!selectedPath}
            >
              <Check size={16} />
              Select
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
