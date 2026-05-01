/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as XLSX from 'xlsx-js-style';
import {
  Users,
  Stethoscope,
  Scale,
  HardHat,
  Download,
  Plus,
  Search,
  MapPin,
  Phone,
  ExternalLink,
  TrendingUp,
  Briefcase,
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  X,
  Contact,
  Trash2,
  MessageCircle,
  Globe,
  Settings,
  UserPlus,
  ThumbsUp,
  ThumbsDown,
  Play,
  Square,
  StickyNote
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { discoverProspects, extractFromText } from './services/aiService';

interface Prospect {
  id: string;
  name: string;
  specialty: string;
  location: string;
  contact: string;
  email?: string;
  category: 'Salud' | 'Legal' | 'Inversión' | 'Arquitectura' | 'Profesionales' | 'Otros';
  source: string;
  contactQuality?: 'direct' | 'generic' | 'pending' | 'qualified' | 'disqualified';
  notes?: string;
  url?: string;
  createdAt?: any;
}

// Detect if contact info is generic (switchboard/generic email)
function detectContactQuality(contact: string, email: string): 'direct' | 'generic' | 'pending' | 'qualified' | 'disqualified' {
  if (!contact && !email) return 'pending';

  const genericEmailPrefixes = ['info@', 'contacto@', 'atencion@', 'recepcion@', 'hola@', 'admin@', 'contact@', 'ventas@', 'general@', 'oficina@'];
  const isGenericEmail = email ? genericEmailPrefixes.some(p => email.toLowerCase().startsWith(p)) : false;
  const hasRealEmail = email && !isGenericEmail;

  // Generic phone indicators: extensions, "conmutador", very round numbers, no direct line
  const isGenericPhone = contact ? (
    contact.toLowerCase().includes('ext') ||
    contact.toLowerCase().includes('conmutador') ||
    contact.includes('0000') ||
    contact.toLowerCase().includes('no disponible')
  ) : false;
  const hasRealPhone = contact && !isGenericPhone;

  // Green: both real phone AND real email
  if (hasRealPhone && hasRealEmail) return 'direct';
  // Yellow: has something but incomplete or generic
  if (contact || email) return 'generic';
  return 'pending';
}

// Auth helper
function getToken(): string | null {
  return localStorage.getItem('prospectos_token');
}

function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
  });
}

function LoginScreen({ onLogin }: { onLogin: (user: any) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await authFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Error de autenticación'); return; }
      localStorage.setItem('prospectos_token', data.token);
      onLogin(data.user);
    } catch {
      setError('Error de conexión');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm bg-white border border-slate-200 shadow-xl p-10"
      >
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-slate-900 rounded flex items-center justify-center text-white">
            <TrendingUp size={20} />
          </div>
          <span className="font-semibold text-lg tracking-tight text-slate-900 uppercase">Prospectos</span>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-2">Usuario</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="w-full px-4 py-3 border border-slate-200 focus:outline-none focus:border-slate-900 text-sm"
              autoFocus
            />
          </div>
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-2">Contraseña</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-4 py-3 border border-slate-200 focus:outline-none focus:border-slate-900 text-sm"
            />
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full text-sm py-3 flex items-center justify-center gap-2"
          >
            {loading ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Iniciar Sesión'}
          </button>
        </form>
      </motion.div>
    </div>
  );
}

export default function App() {
  const [authUser, setAuthUser] = useState<any>(null);
  const [authChecked, setAuthChecked] = useState(false);

  // Check existing token on mount
  useEffect(() => {
    const token = getToken();
    if (!token) { setAuthChecked(true); return; }
    fetch('/api/auth/me', { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => setAuthUser(data.user))
      .catch(() => localStorage.removeItem('prospectos_token'))
      .finally(() => setAuthChecked(true));
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('prospectos_token');
    setAuthUser(null);
  };

  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [totalProspects, setTotalProspects] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [pageSize, setPageSize] = useState(() => {
    const saved = localStorage.getItem('prospectos_page_size');
    return saved ? parseInt(saved) : 50;
  });
  const [searchTerm, setSearchTerm] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>();
  const handleSearchInput = useCallback((value: string) => {
    setSearchInput(value);
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => setSearchTerm(value), 400);
  }, []);
  const [activeCategory, setActiveCategory] = useState<string>('All');
  const [sortBy, setSortBy] = useState<'name' | 'quality' | 'date'>('date');
  const [roles, setRoles] = useState<string[]>(() => {
    const saved = localStorage.getItem('prospectos_all_roles');
    return saved ? JSON.parse(saved) : ['Doctores', 'Abogados', 'Notarios', 'Inversionistas', 'Empresarios', 'Ingenieros', 'Arquitectos', 'Candidatos', 'Especialistas'];
  });
  const [selectedRoles, setSelectedRoles] = useState<string[]>(() => {
    const saved = localStorage.getItem('prospectos_roles');
    return saved ? JSON.parse(saved) : ['Doctores'];
  });
  const [newRole, setNewRole] = useState('');
  const [discoveryLocation, setDiscoveryLocation] = useState<string>(() => {
    return localStorage.getItem('prospectos_location') || 'Ciudad de México';
  });
  const [isAdding, setIsAdding] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [clipboardText, setClipboardText] = useState('');
  const [showClipboard, setShowClipboard] = useState(false);
  const [customSource, setCustomSource] = useState('');
  const [showAdvancedDiscovery, setShowAdvancedDiscovery] = useState(false);
  const [customCity, setCustomCity] = useState('');
  const [cities, setCities] = useState<string[]>(() => {
    const saved = localStorage.getItem('prospectos_cities');
    return saved ? JSON.parse(saved) : ['Ciudad de México', 'Monterrey', 'Guadalajara', 'Querétaro', 'Puebla', 'Mérida', 'León', 'Tijuana'];
  });
  const [sources, setSources] = useState<string[]>(() => {
    const saved = localStorage.getItem('prospectos_sources');
    return saved ? JSON.parse(saved) : ['Doctoralia', 'Sección Amarilla', 'Google Maps', 'Facebook', 'Instagram', 'LinkedIn'];
  });
  const [selectedSources, setSelectedSources] = useState<string[]>(() => {
    const saved = localStorage.getItem('prospectos_selected_sources');
    return saved ? JSON.parse(saved) : ['Doctoralia', 'Sección Amarilla', 'Google Maps', 'Facebook', 'Instagram', 'LinkedIn'];
  });
  const [newSource, setNewSource] = useState('');

  // Persist preferences
  useEffect(() => { localStorage.setItem('prospectos_all_roles', JSON.stringify(roles)); }, [roles]);
  useEffect(() => { localStorage.setItem('prospectos_roles', JSON.stringify(selectedRoles)); }, [selectedRoles]);
  useEffect(() => { localStorage.setItem('prospectos_location', discoveryLocation); }, [discoveryLocation]);
  useEffect(() => { localStorage.setItem('prospectos_cities', JSON.stringify(cities)); }, [cities]);
  useEffect(() => { localStorage.setItem('prospectos_sources', JSON.stringify(sources)); }, [sources]);
  useEffect(() => { localStorage.setItem('prospectos_selected_sources', JSON.stringify(selectedSources)); }, [selectedSources]);

  // Detail modal state
  const [selectedProspect, setSelectedProspect] = useState<Prospect | null>(null);
  const [isEnriching, setIsEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState<any>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Prospect>>({});
  const [isContinuousRunning, setIsContinuousRunning] = useState(false);

  const handleEnrich = async (prospect: Prospect) => {
    setIsEnriching(true);
    setEnrichResult(null);
    try {
      const response = await authFetch('/api/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: prospect.name,
          specialty: prospect.specialty,
          location: prospect.location,
          contact: prospect.contact,
          email: prospect.email,
        }),
      });
      const data = await response.json();
      setEnrichResult(data);
    } catch (error) {
      console.error("Enrich failed", error);
    } finally {
      setIsEnriching(false);
    }
  };

  const applyEnrichment = async (prospect: Prospect, directPhone: string, directEmail: string) => {
    try {
      const newContact = directPhone || prospect.contact;
      const newEmail = directEmail || prospect.email;
      const newQuality = detectContactQuality(newContact, newEmail);
      await authFetch(`/api/prospects/${prospect.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ contact: newContact, email: newEmail, contactQuality: newQuality }),
      });
      await refreshProspects();
      setSelectedProspect({ ...prospect, contact: newContact, email: newEmail, contactQuality: newQuality });
      setEnrichResult(null);
    } catch (error) {
      console.error("Apply enrichment failed", error);
    }
  };

  // Centralized fetch with pagination, search, category, sort
  const refreshProspects = async (opts?: { page?: number; all?: boolean; limit?: number }) => {
    try {
      const page = opts?.page ?? currentPage;
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', String(opts?.limit ?? pageSize));
      if (searchTerm) params.set('search', searchTerm);
      if (activeCategory && activeCategory !== 'All') params.set('category', activeCategory);
      params.set('sort', sortBy);
      if (opts?.all) params.set('all', 'true');
      const response = await authFetch(`/api/prospects?${params}`);
      if (!response.ok) return opts?.all ? [] : undefined;
      const result = await response.json();
      if (opts?.all) return result.data || [];
      setProspects(result.data || []);
      setTotalProspects(result.total || 0);
      setCurrentPage(result.page || 1);
      setTotalPages(result.totalPages || 1);
    } catch (error) {
      console.error("Fetch failed", error);
      if (opts?.all) return [];
    }
  };

  // Sync with SQLite API
  useEffect(() => {
    if (!authUser) return;
    refreshProspects({ page: 1 });
    authFetch('/api/continuous/status').then(r => r.json()).then(d => setIsContinuousRunning(d.active)).catch(() => {});
  }, [authUser]);

  // Re-fetch when search, category, or sort changes
  useEffect(() => {
    if (!authUser) return;
    setCurrentPage(1);
    refreshProspects({ page: 1 });
  }, [searchTerm, activeCategory, sortBy]);

  // Auto-refresh prospects while continuous discovery is running
  useEffect(() => {
    if (!isContinuousRunning || !authUser) return;
    const interval = setInterval(async () => {
      try {
        refreshProspects();
        const statusRes = await authFetch('/api/continuous/status');
        const statusData = await statusRes.json();
        if (!statusData.active) setIsContinuousRunning(false);
      } catch {}
    }, 15000);
    return () => clearInterval(interval);
  }, [isContinuousRunning, authUser]);

  const saveToApi = async (newLeads: Partial<Prospect>[]) => {
    try {
      const response = await authFetch('/api/prospects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newLeads)
      });
      if (response.ok) {
        await refreshProspects({ page: 1 });
      }
    } catch (error) {
      console.error("Save failed", error);
    }
  };

  // New Prospect Form State
  const [newProspect, setNewProspect] = useState<Partial<Prospect>>({
    name: '',
    specialty: '',
    location: '',
    contact: '',
    email: '',
    category: 'Salud',
    source: '',
    notes: ''
  });

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem('prospectos_sidebar') === 'collapsed';
  });
  useEffect(() => { localStorage.setItem('prospectos_sidebar', sidebarCollapsed ? 'collapsed' : 'open'); }, [sidebarCollapsed]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isReviewingAll, setIsReviewingAll] = useState(false);
  const [reviewProgress, setReviewProgress] = useState({ done: 0, total: 0 });

  // User management state
  const [showUserAdmin, setShowUserAdmin] = useState(false);
  const [userList, setUserList] = useState<any[]>([]);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [userForm, setUserForm] = useState({ username: '', password: '', displayName: '', role: 'user' });
  const [userError, setUserError] = useState('');

  const isAdmin = authUser?.role === 'admin';

  const fetchUsers = async () => {
    try {
      const res = await authFetch('/api/users');
      if (res.ok) setUserList(await res.json());
    } catch {}
  };

  const handleSaveUser = async () => {
    setUserError('');
    if (!userForm.username) { setUserError('Usuario requerido'); return; }
    if (!editingUser && !userForm.password) { setUserError('Contraseña requerida'); return; }
    try {
      const url = editingUser ? `/api/users/${editingUser.id}` : '/api/users';
      const method = editingUser ? 'PATCH' : 'POST';
      const body: any = { username: userForm.username, displayName: userForm.displayName, role: userForm.role };
      if (userForm.password) body.password = userForm.password;
      const res = await authFetch(url, { method, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) { setUserError(data.error); return; }
      setEditingUser(null);
      setUserForm({ username: '', password: '', displayName: '', role: 'user' });
      fetchUsers();
    } catch { setUserError('Error de conexión'); }
  };

  const handleDeleteUser = async (id: string) => {
    if (!confirm('¿Eliminar este usuario?')) return;
    try {
      await authFetch(`/api/users/${id}`, { method: 'DELETE' });
      fetchUsers();
    } catch {}
  };

  // filteredProspects is now just the server-paginated data
  const filteredProspects = prospects;

  const handleReviewAll = async (onlyPending = false) => {
    const targets = prospects.filter(p => {
      const q = p.contactQuality || detectContactQuality(p.contact, p.email || '');
      if (q === 'qualified' || q === 'disqualified') return false; // Skip manually set
      return onlyPending ? (q === 'pending' || !p.contactQuality) : (q !== 'direct');
    });
    if (targets.length === 0) return;

    setIsReviewingAll(true);
    setReviewProgress({ done: 0, total: targets.length });

    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      const quality = detectContactQuality(p.contact, p.email || '');

      // Step 1: Qualify
      try {
        await fetch(`/api/prospects/${p.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactQuality: quality }),
        });
      } catch {}

      // Step 2: OSINT enrich if not green
      if (quality !== 'direct') {
        try {
          const enrichRes = await authFetch('/api/enrich', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: p.name,
              specialty: p.specialty,
              location: p.location,
              contact: p.contact,
              email: p.email,
            }),
          });
          const enrichData = await enrichRes.json();
          if (enrichData.direct_phone || enrichData.direct_email) {
            const newContact = enrichData.direct_phone || p.contact;
            const newEmail = enrichData.direct_email || p.email;
            const newQuality = detectContactQuality(newContact, newEmail);
            await fetch(`/api/prospects/${p.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contact: newContact, email: newEmail, contactQuality: newQuality }),
            });
          }
        } catch {}
      }

      setReviewProgress({ done: i + 1, total: targets.length });
    }

    await refreshProspects();
    setIsReviewingAll(false);
  };

  const downloadVCF = (prospect: Prospect) => {
    const nameParts = prospect.name.split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${prospect.name}`,
      `N:${lastName};${firstName};;;`,
      prospect.contact ? `TEL;TYPE=WORK:${prospect.contact}` : '',
      prospect.email ? `EMAIL;TYPE=WORK:${prospect.email}` : '',
      prospect.specialty ? `TITLE:${prospect.specialty}` : '',
      prospect.location ? `ADR;TYPE=WORK:;;${prospect.location};;;;` : '',
      prospect.category ? `CATEGORIES:${prospect.category}` : '',
      prospect.source ? `NOTE:Fuente: ${prospect.source}` : '',
      'END:VCARD',
    ].filter(Boolean).join('\r\n');

    const blob = new Blob([vcf], { type: 'text/vcard;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${prospect.name.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ ]/g, '')}.vcf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredProspects.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredProspects.map(p => p.id)));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`¿Eliminar ${selectedIds.size} prospecto(s)? Esta acción no se puede deshacer.`)) return;
    try {
      await authFetch('/api/prospects', {
        method: 'DELETE',
        body: JSON.stringify({ ids: [...selectedIds] }),
      });
      await refreshProspects();
      setSelectedIds(new Set());
    } catch (error) {
      console.error("Delete failed", error);
    }
  };

  const handleBulkOsint = async () => {
    if (selectedIds.size === 0) return;
    const targets = prospects.filter(p => selectedIds.has(p.id));
    setIsReviewingAll(true);
    setReviewProgress({ done: 0, total: targets.length });

    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      const quality = detectContactQuality(p.contact, p.email || '');
      try {
        await fetch(`/api/prospects/${p.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactQuality: quality }),
        });
      } catch {}
      if (quality !== 'direct') {
        try {
          const enrichRes = await authFetch('/api/enrich', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: p.name, specialty: p.specialty, location: p.location, contact: p.contact, email: p.email }),
          });
          const enrichData = await enrichRes.json();
          if (enrichData.direct_phone || enrichData.direct_email) {
            const newContact = enrichData.direct_phone || p.contact;
            const newEmail = enrichData.direct_email || p.email;
            const newQuality = detectContactQuality(newContact, newEmail);
            await fetch(`/api/prospects/${p.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contact: newContact, email: newEmail, contactQuality: newQuality }),
            });
          }
        } catch {}
      }
      setReviewProgress({ done: i + 1, total: targets.length });
    }

    await refreshProspects();
    setIsReviewingAll(false);
    setSelectedIds(new Set());
  };

  const handleBulkVCF = () => {
    if (selectedIds.size === 0) return;
    const targets = prospects.filter(p => selectedIds.has(p.id));
    const vcfAll = targets.map(prospect => {
      const nameParts = prospect.name.split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      return [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${prospect.name}`,
        `N:${lastName};${firstName};;;`,
        prospect.contact ? `TEL;TYPE=WORK:${prospect.contact}` : '',
        prospect.email ? `EMAIL;TYPE=WORK:${prospect.email}` : '',
        prospect.specialty ? `TITLE:${prospect.specialty}` : '',
        prospect.location ? `ADR;TYPE=WORK:;;${prospect.location};;;;` : '',
        prospect.category ? `CATEGORIES:${prospect.category}` : '',
        prospect.source ? `NOTE:Fuente: ${prospect.source}` : '',
        'END:VCARD',
      ].filter(Boolean).join('\r\n');
    }).join('\r\n');

    const blob = new Blob([vcfAll], { type: 'text/vcard;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `prospectos_${targets.length}.vcf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const startEditing = (prospect: Prospect) => {
    setEditForm({ name: prospect.name, specialty: prospect.specialty, location: prospect.location, contact: prospect.contact, email: prospect.email || '', category: prospect.category, source: prospect.source, notes: prospect.notes || '', url: prospect.url || '' });
    setIsEditing(true);
  };

  const handleManualQualify = async (prospect: Prospect, status: 'qualified' | 'disqualified') => {
    try {
      await authFetch(`/api/prospects/${prospect.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ contactQuality: status }),
      });
      await refreshProspects();
      setSelectedProspect({ ...prospect, contactQuality: status });
    } catch (error) {
      console.error("Qualify failed", error);
    }
  };

  const handleContinuousDiscovery = async () => {
    if (isContinuousRunning) {
      await authFetch('/api/continuous/stop', { method: 'POST' });
      setIsContinuousRunning(false);
    } else {
      const allSources = customSource ? [...selectedSources, customSource] : selectedSources;
      await authFetch('/api/continuous/start', {
        method: 'POST',
        body: JSON.stringify({ categories: selectedRoles, location: discoveryLocation, sources: allSources }),
      });
      setIsContinuousRunning(true);
      setShowAdvancedDiscovery(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!selectedProspect) return;
    try {
      // Preserve manual qualification status
      const currentQ = selectedProspect.contactQuality;
      const newQ = (currentQ === 'qualified' || currentQ === 'disqualified') ? currentQ : detectContactQuality(editForm.contact || '', editForm.email || '');
      await authFetch(`/api/prospects/${selectedProspect.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...editForm, contactQuality: newQ }),
      });
      await refreshProspects();
      setSelectedProspect({ ...selectedProspect, ...editForm, contactQuality: newQ } as Prospect);
      setIsEditing(false);
    } catch (error) {
      console.error("Save edit failed", error);
    }
  };

  const handleDeleteProspect = async (prospect: Prospect) => {
    if (!confirm(`¿Eliminar "${prospect.name}"?`)) return;
    try {
      await authFetch('/api/prospects', {
        method: 'DELETE',
        body: JSON.stringify({ ids: [prospect.id] }),
      });
      await refreshProspects();
      setSelectedProspect(null);
    } catch (error) {
      console.error("Delete failed", error);
    }
  };

  const handleDiscovery = async () => {
    if (selectedRoles.length === 0) return;
    setIsDiscovering(true);
    setShowAdvancedDiscovery(false); // Close modal immediately, process runs in background
    try {
      const allSources = customSource ? [...selectedSources, customSource] : selectedSources;
      const data = await discoverProspects(selectedRoles, discoveryLocation, allSources.join(', '));
      if (data.leads) {
        const mappedLeads = data.leads.map((l: any) => {
          let category: Prospect['category'] = 'Otros';
          const combined = ((l.name || '') + ' ' + (l.specialty || '') + ' ' + (l.category || '')).toLowerCase();
          // Check specialty/name first (more specific), then fall back to selectedRoles
          const rolesLower = selectedRoles.join(' ').toLowerCase();

          if (combined.includes('doctor') || combined.includes('médic') || combined.includes('medic') || combined.includes('dentista') || combined.includes('clínica') || combined.includes('clinica') || combined.includes('hospital') || combined.includes('ciruj') || combined.includes('salud')) category = 'Salud';
          else if (combined.includes('abogado') || combined.includes('legal') || combined.includes('notario') || combined.includes('jurídic')) category = 'Legal';
          else if (combined.includes('inversionista') || combined.includes('empresario') || combined.includes('dueño') || combined.includes('socio')) category = 'Inversión';
          else if (combined.includes('arquitect') || combined.includes('ingenier') || combined.includes('construcción') || combined.includes('civil')) category = 'Arquitectura';
          else if (combined.includes('profesional') || combined.includes('especialista') || combined.includes('consult')) category = 'Profesionales';
          // If no match from content, infer from selected roles
          else if (rolesLower.includes('doctor')) category = 'Salud';
          else if (rolesLower.includes('abogado') || rolesLower.includes('notario')) category = 'Legal';
          else if (rolesLower.includes('inversionista') || rolesLower.includes('empresario')) category = 'Inversión';
          else if (rolesLower.includes('arquitect') || rolesLower.includes('ingenier')) category = 'Arquitectura';

          return { ...l, category };
        });
        await saveToApi(mappedLeads);
        setCustomSource('');

        // Auto-qualify and OSINT enrich non-green contacts in background
        setIsDiscovering(false);
        setTimeout(() => handleReviewAll(false), 500);
        return;
      }
    } catch (error) {
      console.error("Discovery failed", error);
    } finally {
      setIsDiscovering(false);
    }
  };

  const [extractionError, setExtractionError] = useState('');

  const handleExtraction = async () => {
    if (!clipboardText) return;
    setIsDiscovering(true);
    setExtractionError('');
    try {
      const data = await extractFromText(clipboardText);
      if (data.leads && data.leads.length > 0) {
        const mappedLeads = data.leads.map((l: any) => {
          let category: Prospect['category'] = (activeCategory === 'All' ? 'Otros' : activeCategory) as any;

          const combined = ((l.specialty || '') + ' ' + (l.name || '') + ' ' + (l.category || '')).toLowerCase();
          if (combined.includes('doctor') || combined.includes('médic') || combined.includes('medic') || combined.includes('dentista') || combined.includes('clínica') || combined.includes('clinica') || combined.includes('hospital') || combined.includes('ciruj')) category = 'Salud';
          else if (combined.includes('abogado') || combined.includes('legal') || combined.includes('notario') || combined.includes('jurídic')) category = 'Legal';
          else if (combined.includes('invers') || combined.includes('empresario') || combined.includes('dueño') || combined.includes('socio')) category = 'Inversión';
          else if (combined.includes('arq') || combined.includes('ingenier') || combined.includes('const') || combined.includes('civil')) category = 'Arquitectura';
          else if (combined.includes('profesional') || combined.includes('especialista') || combined.includes('consult')) category = 'Profesionales';

          return { ...l, category };
        });
        await saveToApi(mappedLeads);
        setClipboardText('');
        setShowClipboard(false);
      } else {
        setExtractionError(`No se encontraron prospectos en el texto. Asegúrate de que contenga nombres y datos de contacto.`);
      }
    } catch (error) {
      console.error("Extraction failed", error);
    } finally {
      setIsDiscovering(false);
    }
  };

  const exportToExcel = async () => {
    // Fetch ALL prospects for export
    const allData = await refreshProspects({ all: true }) as Prospect[] || [];
    const sorted = [...allData].sort((a, b) => a.category.localeCompare(b.category));

    const headers = ['Nombre', 'Especialidad', 'Ubicación', 'Contacto', 'Email', 'Categoría', 'Calidad', 'Fuente'];
    const headerStyle = {
      font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
      fill: { fgColor: { rgb: '1E293B' } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: {
        bottom: { style: 'thin', color: { rgb: '000000' } },
      },
    };
    const categoryStyle = {
      font: { bold: true, sz: 11, color: { rgb: '1E293B' } },
      fill: { fgColor: { rgb: 'F1F5F9' } },
      alignment: { horizontal: 'left' },
    };
    const cellBorder = {
      border: {
        bottom: { style: 'thin', color: { rgb: 'E2E8F0' } },
      },
    };

    const rows: any[][] = [];

    for (const p of sorted) {
      const q = p.contactQuality || detectContactQuality(p.contact, p.email || '');
      rows.push([
        p.name,
        p.specialty,
        p.location,
        p.contact,
        p.email || '',
        p.category,
        q === 'qualified' ? 'Calificado' : q === 'direct' ? 'Directo' : q === 'generic' ? 'Genérico' : q === 'disqualified' ? 'Descalificado' : 'Pendiente',
        p.source,
      ]);
    }

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);

    // Style headers (row 0)
    for (let c = 0; c < headers.length; c++) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: 0, c })];
      if (cell) cell.s = headerStyle;
    }

    // Style data cells
    for (let rowIdx = 1; rowIdx <= rows.length; rowIdx++) {
      for (let c = 0; c < headers.length; c++) {
        const cell = worksheet[XLSX.utils.encode_cell({ r: rowIdx, c })];
        if (cell) cell.s = cellBorder;
      }
      // Color the quality cell
      const qCell = worksheet[XLSX.utils.encode_cell({ r: rowIdx, c: 6 })];
      if (qCell) {
        const q = (qCell.v as string) || '';
        qCell.s = {
          ...cellBorder,
          font: { color: { rgb: q === 'Calificado' ? '2563EB' : q === 'Directo' ? '16A34A' : q === 'Genérico' ? 'D97706' : q === 'Descalificado' ? 'DC2626' : '94A3B8' }, bold: true, sz: 10 },
        };
      }
    }

    worksheet['!cols'] = [
      { wch: 32 }, { wch: 30 }, { wch: 25 }, { wch: 18 }, { wch: 28 }, { wch: 15 }, { wch: 14 }, { wch: 35 },
    ];
    worksheet['!rows'] = [{ hpx: 28 }]; // Header row height

    // AutoFilter on header row
    worksheet['!autofilter'] = { ref: `A1:H${rows.length + 1}` };

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Prospectos');
    XLSX.writeFile(workbook, 'prospectos.xlsx');
  };

  const exportToCSV = async () => {
    const allData = await refreshProspects({ all: true }) as Prospect[] || [];
    const headers = ['Nombre', 'Especialidad', 'Ubicación', 'Contacto', 'Email', 'Categoría', 'Fuente'];
    const rows = allData.map(p => [
      `"${p.name.replace(/"/g, '""')}"`,
      `"${p.specialty.replace(/"/g, '""')}"`,
      `"${p.location.replace(/"/g, '""')}"`,
      `"${p.contact.replace(/"/g, '""')}"`,
      `"${(p.email || '').replace(/"/g, '""')}"`,
      `"${p.category.replace(/"/g, '""')}"`,
      `"${p.source.replace(/"/g, '""')}"`
    ]);
    
    // Using BOM (Byte Order Mark) for UTF-8 and sep=; for Excel discovery
    const csvContent = "sep=;\n" + headers.join(";") + "\n" + rows.map(e => e.join(";")).join("\n");
    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "prospectos.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleAddProspect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProspect.name) return;
    
    await saveToApi([{
      name: newProspect.name,
      specialty: newProspect.specialty,
      location: newProspect.location,
      contact: newProspect.contact,
      email: newProspect.email,
      category: newProspect.category as any,
      source: newProspect.source || 'Manual',
      notes: newProspect.notes
    }]);

    setNewProspect({ name: '', specialty: '', location: '', contact: '', email: '', category: 'Salud', source: '', notes: '' });
    setIsAdding(false);
  };

  // --- Search Person ---
  const [showSearchPerson, setShowSearchPerson] = useState(false);
  const [searchPersonForm, setSearchPersonForm] = useState({ name: '', location: '', specialty: '', category: 'Profesionales' as Prospect['category'] });
  const [searchPersonLoading, setSearchPersonLoading] = useState(false);

  const handleSearchPerson = async () => {
    if (!searchPersonForm.name.trim()) return;
    setSearchPersonLoading(true);
    try {
      // 1. Create prospect
      const res = await authFetch('/api/prospects', {
        method: 'POST',
        body: JSON.stringify([{
          name: searchPersonForm.name.trim(),
          location: searchPersonForm.location.trim(),
          specialty: searchPersonForm.specialty.trim(),
          contact: '',
          email: '',
          category: searchPersonForm.category,
          source: 'Búsqueda directa',
        }]),
      });
      if (!res.ok) throw new Error('Save failed');

      // 2. Refresh to get the new prospect with ID
      await refreshProspects({ page: 1 });

      // Small delay to ensure state update
      const listRes = await authFetch(`/api/prospects?search=${encodeURIComponent(searchPersonForm.name.trim())}&limit=1`);
      const listData = await listRes.json();
      const created = listData.data?.[0];

      if (created) {
        // 3. Open detail and run OSINT automatically
        setSelectedProspect(created);
        setShowSearchPerson(false);
        setSearchPersonForm({ name: '', location: '', specialty: '', category: 'Profesionales' });
        handleEnrich(created);
      }
    } catch (error) {
      console.error("Search person failed", error);
    } finally {
      setSearchPersonLoading(false);
    }
  };

  if (!authChecked) return <div className="min-h-screen bg-slate-50 flex items-center justify-center"><div className="w-6 h-6 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" /></div>;
  if (!authUser) return <LoginScreen onLogin={setAuthUser} />;

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      {/* Sidebar / Navigation */}
      <nav className={`fixed top-0 left-0 h-screen bg-white border-r border-slate-200 hidden sm:flex flex-col z-20 transition-all duration-300 ${sidebarCollapsed ? 'w-16' : 'w-64'}`}>
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className="p-4 border-b border-slate-100 flex items-center gap-3 w-full hover:bg-slate-50 transition-colors cursor-pointer"
          title={sidebarCollapsed ? 'Expandir sidebar' : 'Colapsar sidebar'}
        >
          <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center text-white shrink-0">
            <TrendingUp size={16} />
          </div>
          {!sidebarCollapsed && <span className="font-semibold text-sm tracking-tight text-slate-900 uppercase">Prospectos</span>}
        </button>

        <div className="flex-1 px-2 py-6 space-y-1 overflow-y-auto">
          {['All', 'Salud', 'Legal', 'Inversión', 'Arquitectura', 'Profesionales', 'Otros'].map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              title={cat === 'All' ? 'Todos' : cat}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded transition-all duration-200 ${
                activeCategory === cat
                ? 'bg-slate-900 text-white font-medium'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <div className="w-5 flex justify-center shrink-0">
                {cat === 'All' && <Users size={18} />}
                {cat === 'Salud' && <Stethoscope size={18} />}
                {cat === 'Legal' && <Scale size={18} />}
                {cat === 'Inversión' && <TrendingUp size={18} />}
                {cat === 'Arquitectura' && <HardHat size={18} />}
                {cat === 'Profesionales' && <Briefcase size={18} />}
                {cat === 'Otros' && <Plus size={18} />}
              </div>
              {!sidebarCollapsed && <span className="text-xs font-medium">{cat === 'All' ? 'Todos los registros' : cat}</span>}
            </button>
          ))}
        </div>

        <div className="p-4 border-t border-slate-100 space-y-3">
          {!sidebarCollapsed && (
            <div>
              <div className="flex justify-between items-end mb-2">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total</span>
                <span className="text-[10px] font-mono text-slate-500">{totalProspects}</span>
              </div>
              <div className="w-full bg-slate-100 h-1 rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(totalProspects, 100)}%` }}
                  className="bg-slate-900 h-full"
                />
              </div>
            </div>
          )}
          <div className="flex items-center gap-1">
            <button
              onClick={handleLogout}
              className="flex-1 flex items-center justify-center gap-2 p-2 text-slate-400 hover:text-red-500 transition-colors text-xs"
              title="Cerrar sesión"
            >
              <X size={14} />
              {!sidebarCollapsed && <span className="truncate">{authUser?.displayName || 'Salir'}</span>}
            </button>
            {isAdmin && (
              <button
                onClick={() => { setShowUserAdmin(true); fetchUsers(); }}
                className="p-2 text-slate-400 hover:text-slate-900 transition-colors shrink-0"
                title="Administrar usuarios"
              >
                <Settings size={14} />
              </button>
            )}
          </div>
        </div>
      </nav>

      {/* Background process indicator */}
      <AnimatePresence>
        {isDiscovering && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-4 right-4 z-50 bg-slate-900 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-3"
          >
            <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
            <span className="text-xs font-medium">Buscando prospectos...</span>
          </motion.div>
        )}
        {isContinuousRunning && !isDiscovering && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-4 right-4 z-50 bg-blue-600 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-3 cursor-pointer"
            onClick={handleContinuousDiscovery}
          >
            <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
            <span className="text-xs font-medium">Descubrimiento continuo activo</span>
            <Square size={12} />
          </motion.div>
        )}
      </AnimatePresence>

      <main className={`p-6 md:p-10 transition-all duration-300 ${sidebarCollapsed ? 'sm:ml-16' : 'sm:ml-64'}`}>
        <header className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 mb-12">
          <div>
            <div className="flex items-center gap-2 text-slate-400 text-[10px] font-bold uppercase tracking-[0.2em] mb-2">
              <span>CRM</span>
            </div>
            <h1 className="text-4xl font-light text-slate-900 tracking-tight">Prospectos</h1>
          </div>
          
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setIsAdding(true)}
              className="btn-primary flex items-center gap-2 text-xs"
            >
              <Plus size={14} />
              Añadir manual
            </button>
            <button
              onClick={() => setShowSearchPerson(true)}
              className="btn-primary flex items-center gap-2 text-xs bg-blue-600 hover:bg-blue-700 border-blue-600"
            >
              <Search size={14} />
              Buscar persona
            </button>
            <button 
              disabled={isDiscovering}
              onClick={() => setShowAdvancedDiscovery(true)}
              className="btn-secondary flex items-center gap-2 text-xs"
            >
              {isDiscovering ? <div className="w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" /> : <TrendingUp size={14} />}
              Descubrimiento AI
            </button>
            <button
              onClick={handleContinuousDiscovery}
              className={`flex items-center gap-2 text-xs ${isContinuousRunning ? 'btn-primary bg-red-600 hover:bg-red-700 border-red-600' : 'btn-secondary'}`}
              title={isContinuousRunning ? 'Detener descubrimiento continuo' : 'Iniciar descubrimiento continuo'}
            >
              {isContinuousRunning ? <><Square size={14} /> Detener continuo</> : <><Play size={14} /> Continuo</>}
            </button>
            <button
              onClick={() => setShowClipboard(!showClipboard)}
              className="btn-secondary flex items-center gap-2 text-xs"
            >
              <Download size={14} />
              Importar texto
            </button>
            <div className="h-6 w-px bg-slate-200 mx-1 hidden sm:block"></div>
            <button 
              onClick={exportToExcel}
              className="p-2 text-slate-400 hover:text-emerald-600 transition-colors"
              title="Exportar Excel"
            >
              <Download size={18} />
            </button>
          </div>
        </header>

        {/* Extraction Panel */}
        <AnimatePresence>
          {showClipboard && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mb-10 overflow-hidden"
            >
              <div className="bg-white border border-slate-900 p-8">
                <h3 className="font-medium text-lg mb-2">Extracción Inteligente</h3>
                <p className="text-slate-500 text-sm mb-6">Pega texto de cualquier fuente: CSV, directorio, red social, email, lista de contactos, etc.</p>
                <textarea
                  className="w-full h-32 bg-slate-50 border border-slate-200 p-4 text-slate-900 text-sm focus:outline-none focus:border-slate-900 transition-colors resize-none font-mono"
                  placeholder={"Nombre;Especialidad;Ciudad;Teléfono;Email\nDr. Juan Pérez;Cardiólogo;CDMX;5512345678;juan@clinica.com\n\n— o pega cualquier texto con datos de contacto —"}
                  value={clipboardText}
                  onChange={(e) => { setClipboardText(e.target.value); setExtractionError(''); }}
                />
                {extractionError && (
                  <p className="mt-2 text-xs text-red-500">{extractionError}</p>
                )}
                <div className="mt-6 flex items-center justify-between">
                  <span className="text-[10px] text-slate-400">CSV, TSV, texto libre, HTML — cualquier formato</span>
                  <div className="flex gap-3">
                    <button onClick={() => { setShowClipboard(false); setExtractionError(''); }} className="text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-slate-900 transition-colors">Cancelar</button>
                    <button
                      disabled={isDiscovering || !clipboardText}
                      onClick={handleExtraction}
                      className="btn-primary text-xs flex items-center gap-2 disabled:opacity-50"
                    >
                      {isDiscovering ? "Procesando..." : "Extraer Información"}
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-px bg-slate-200 border border-slate-200 mb-12 shadow-sm rounded-lg overflow-hidden">
          {[
            { label: 'Registros', value: totalProspects },
            { label: 'Salud', value: prospects.filter(p => p.category === 'Salud').length },
            { label: 'Legal', value: prospects.filter(p => p.category === 'Legal').length },
            { label: 'Inversión', value: prospects.filter(p => p.category === 'Inversión').length },
            { label: 'Arquitectura', value: prospects.filter(p => p.category === 'Arquitectura').length },
            { label: 'Meta', value: '100+' },
          ].map((stat, i) => (
            <div key={i} className="bg-white p-6">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">{stat.label}</span>
              <span className="text-2xl font-light text-slate-900">{stat.value}</span>
            </div>
          ))}
        </div>

        {/* Search Bar + Controls */}
        <div className="flex flex-col sm:flex-row gap-3 mb-8">
          <div className="relative flex-1 group">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-slate-900 transition-colors" size={18} />
            <input
              type="text"
              placeholder="Filtrar por nombre, especialidad o ubicación..."
              className="w-full pl-12 pr-4 py-3 bg-white border border-slate-200 focus:outline-none focus:border-slate-900 transition-all text-sm text-slate-900"
              value={searchInput}
              onChange={(e) => handleSearchInput(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value as any)}
              className="px-3 py-2 bg-white border border-slate-200 text-xs text-slate-600 focus:outline-none focus:border-slate-900"
            >
              <option value="date">Recientes</option>
              <option value="quality">Confianza</option>
              <option value="name">Nombre</option>
            </select>
            <button
              disabled={isReviewingAll}
              onClick={() => handleReviewAll(false)}
              className="btn-secondary text-xs whitespace-nowrap flex items-center gap-2"
            >
              {isReviewingAll ? (
                <><div className="w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" /> OSINT {reviewProgress.done}/{reviewProgress.total}</>
              ) : (
                <><CheckCircle size={14} /> Calificar + OSINT</>
              )}
            </button>
          </div>
        </div>

        {/* Bulk Actions Bar */}
        {selectedIds.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 p-3 bg-slate-900 text-white rounded-lg flex items-center gap-3"
          >
            <span className="text-xs font-medium">{selectedIds.size} seleccionado(s)</span>
            <div className="h-4 w-px bg-slate-600" />
            <button onClick={handleBulkDelete} className="text-xs flex items-center gap-1.5 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/40 rounded transition-colors">
              <Trash2 size={12} /> Eliminar
            </button>
            <button
              onClick={handleBulkOsint}
              disabled={isReviewingAll}
              className="text-xs flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded transition-colors"
            >
              {isReviewingAll ? (
                <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> {reviewProgress.done}/{reviewProgress.total}</>
              ) : (
                <><CheckCircle size={12} /> Calificar + OSINT</>
              )}
            </button>
            <button onClick={handleBulkVCF} className="text-xs flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded transition-colors">
              <Contact size={12} /> Exportar VCF
            </button>
            <button onClick={() => setSelectedIds(new Set())} className="ml-auto text-xs text-slate-400 hover:text-white transition-colors">
              Deseleccionar
            </button>
          </motion.div>
        )}

        {/* Prospect Table */}
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden mb-12">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="px-2 py-4 w-8 text-center">
                    <input
                      type="checkbox"
                      checked={selectedIds.size === filteredProspects.length && filteredProspects.length > 0}
                      onChange={toggleSelectAll}
                      className="w-3.5 h-3.5 rounded border-slate-300 cursor-pointer"
                    />
                  </th>
                  <th className="px-4 py-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest w-8 text-center">
                    <span title="Confianza">Q</span>
                  </th>
                  <th className="px-4 py-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Identidad</th>
                  <th className="px-4 py-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Especialidad / Fuente</th>
                  <th className="px-4 py-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Ubicación</th>
                  <th className="px-4 py-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Contacto</th>
                  <th className="px-4 py-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <AnimatePresence mode='popLayout'>
                  {filteredProspects.map((prospect) => (
                    <motion.tr
                      key={prospect.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      onClick={() => { setSelectedProspect(prospect); setEnrichResult(null); }}
                      className="hover:bg-slate-50 transition-colors group cursor-pointer"
                    >
                      <td className="px-2 py-4 text-center" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(prospect.id)}
                          onChange={() => {}}
                          onClick={(e) => toggleSelect(prospect.id, e)}
                          className="w-3.5 h-3.5 rounded border-slate-300 cursor-pointer"
                        />
                      </td>
                      <td className="px-4 py-4 text-center">
                        {(() => {
                          const q = prospect.contactQuality || detectContactQuality(prospect.contact, prospect.email || '');
                          return (
                            <div className={`w-3 h-3 rounded-full mx-auto ${
                              q === 'qualified' ? 'bg-blue-500' :
                              q === 'direct' ? 'bg-emerald-400' :
                              q === 'generic' ? 'bg-amber-400' :
                              q === 'disqualified' ? 'bg-red-400' :
                              'bg-slate-300'
                            }`} title={
                              q === 'qualified' ? 'Calificado manualmente' :
                              q === 'direct' ? 'Contacto directo' :
                              q === 'generic' ? 'Contacto genérico' :
                              q === 'disqualified' ? 'Descalificado' :
                              'Sin evaluar'
                            } />
                          );
                        })()}
                      </td>
                      <td className="px-4 py-4">
                        <div>
                          <div className="flex items-center gap-1.5">
                            <p className="font-medium text-sm text-slate-900">{prospect.name}</p>
                            {prospect.notes && <StickyNote size={10} className="text-amber-400 shrink-0" title={prospect.notes} />}
                          </div>
                          <div className="flex items-center gap-1.5 mt-1" onClick={e => e.stopPropagation()}>
                            <div className={`w-1.5 h-1.5 rounded-full ${
                              prospect.category === 'Salud' ? 'bg-rose-400' :
                              prospect.category === 'Legal' ? 'bg-amber-400' :
                              prospect.category === 'Inversión' ? 'bg-indigo-400' :
                              prospect.category === 'Arquitectura' ? 'bg-emerald-400' :
                              'bg-slate-300'
                            }`} />
                            <select
                              value={prospect.category}
                              onChange={e => {
                                authFetch(`/api/prospects/${prospect.id}`, {
                                  method: 'PATCH',
                                  body: JSON.stringify({ category: e.target.value }),
                                }).then(() => refreshProspects());
                              }}
                              className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter bg-transparent border-none cursor-pointer focus:outline-none hover:text-slate-900 transition-colors p-0"
                            >
                              <option value="Salud">Salud</option>
                              <option value="Legal">Legal</option>
                              <option value="Inversión">Inversión</option>
                              <option value="Arquitectura">Arquitectura</option>
                              <option value="Profesionales">Profesionales</option>
                              <option value="Otros">Otros</option>
                            </select>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <p className="text-xs text-slate-600">{prospect.specialty}</p>
                        <p className="text-[10px] font-mono text-slate-400 mt-1 truncate max-w-[200px]">{prospect.source}</p>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-1.5 text-xs text-slate-500">
                          <MapPin size={12} className="text-slate-300 shrink-0" />
                          <span className="truncate max-w-[180px]">{prospect.location}</span>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-col gap-0.5">
                          <p className="text-xs font-medium text-slate-900">{prospect.contact || '-'}</p>
                          <p className="text-[10px] text-slate-400">{prospect.email || ''}</p>
                        </div>
                      </td>
                      <td className="px-4 py-4" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => {
                              const q = detectContactQuality(prospect.contact, prospect.email || '');
                              authFetch(`/api/prospects/${prospect.id}`, {
                                method: 'PATCH',
                                body: JSON.stringify({ contactQuality: q }),
                              }).then(() => refreshProspects());
                            }}
                            title="Calificar"
                            className="p-1.5 text-slate-400 hover:text-amber-500 hover:bg-amber-50 rounded transition-colors"
                          >
                            <CheckCircle size={14} />
                          </button>
                          <button
                            onClick={() => { setSelectedProspect(prospect); setEnrichResult(null); handleEnrich(prospect); }}
                            title="OSINT"
                            className="p-1.5 text-slate-400 hover:text-blue-500 hover:bg-blue-50 rounded transition-colors"
                          >
                            <RefreshCw size={14} />
                          </button>
                          <button
                            onClick={() => { setSelectedProspect(prospect); setEnrichResult(null); startEditing(prospect); }}
                            title="Editar"
                            className="p-1.5 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded transition-colors"
                          >
                            <ExternalLink size={14} />
                          </button>
                          {prospect.contact && (
                            <button
                              onClick={() => {
                                const phone = prospect.contact.replace(/[\s\-().+]/g, '').replace(/^52/, '');
                                window.open(`https://wa.me/52${phone}`, '_blank');
                              }}
                              title="WhatsApp"
                              className="p-1.5 text-slate-400 hover:text-green-500 hover:bg-green-50 rounded transition-colors"
                            >
                              <MessageCircle size={14} />
                            </button>
                          )}
                          {(() => {
                            const urlMatch = prospect.source?.match(/(?:https?:\/\/)?([a-zA-Z0-9\-]+(?:\.[a-zA-Z0-9\-]+)+\.[a-zA-Z]{2,})/);
                            return urlMatch ? (
                              <button
                                onClick={() => window.open(urlMatch[0].startsWith('http') ? urlMatch[0] : `https://${urlMatch[0]}`, '_blank')}
                                title={urlMatch[0]}
                                className="p-1.5 text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 rounded transition-colors"
                              >
                                <Globe size={14} />
                              </button>
                            ) : null;
                          })()}
                          <button
                            onClick={() => handleDeleteProspect(prospect)}
                            title="Eliminar"
                            className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
            {filteredProspects.length === 0 && (
              <div className="py-20 text-center">
                <p className="text-slate-400 text-xs font-medium">No results matching your query.</p>
              </div>
            )}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200">
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-500">
                {totalProspects > 0 ? `${((currentPage - 1) * pageSize) + 1}–${Math.min(currentPage * pageSize, totalProspects)} de ${totalProspects}` : '0 registros'}
              </span>
              <select
                value={pageSize}
                onChange={e => {
                  const newSize = parseInt(e.target.value);
                  setPageSize(newSize);
                  localStorage.setItem('prospectos_page_size', String(newSize));
                  setCurrentPage(1);
                  refreshProspects({ page: 1, limit: newSize });
                }}
                className="px-2 py-1 text-[10px] border border-slate-200 rounded bg-white text-slate-600 focus:outline-none focus:border-slate-900"
              >
                <option value={15}>15 por página</option>
                <option value={50}>50 por página</option>
                <option value={100}>100 por página</option>
                <option value={200}>200 por página</option>
              </select>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  disabled={currentPage <= 1}
                  onClick={() => { setCurrentPage(currentPage - 1); refreshProspects({ page: currentPage - 1 }); }}
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Anterior
                </button>
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  let page: number;
                  if (totalPages <= 7) {
                    page = i + 1;
                  } else if (currentPage <= 4) {
                    page = i + 1;
                  } else if (currentPage >= totalPages - 3) {
                    page = totalPages - 6 + i;
                  } else {
                    page = currentPage - 3 + i;
                  }
                  return (
                    <button
                      key={page}
                      onClick={() => { setCurrentPage(page); refreshProspects({ page }); }}
                      className={`w-8 h-8 text-xs rounded transition-colors ${
                        page === currentPage ? 'bg-slate-900 text-white' : 'hover:bg-slate-100 text-slate-600'
                      }`}
                    >
                      {page}
                    </button>
                  );
                })}
                <button
                  disabled={currentPage >= totalPages}
                  onClick={() => { setCurrentPage(currentPage + 1); refreshProspects({ page: currentPage + 1 }); }}
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Siguiente
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Resources Grid */}
        <section className="mt-20">
          <div className="flex items-center gap-4 mb-8">
            <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-slate-900">Fuentes de Búsqueda</h2>
            <div className="h-px flex-1 bg-slate-200" />
          </div>
          
          <div className="grid md:grid-cols-3 gap-6">
            {sources.map((source, i) => (
              <div key={i} className="group cursor-pointer">
                <div className="text-slate-900 font-mono text-xs mb-3">{String(i + 1).padStart(2, '0')}</div>
                <h3 className="font-semibold text-slate-900 mb-2">{source}</h3>
                <p className="text-xs text-slate-500 leading-relaxed mb-4">
                  {selectedSources.includes(source) ? 'Activa' : 'Inactiva'}
                </p>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* Discover Modal */}
      <AnimatePresence>
        {showAdvancedDiscovery && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              onClick={() => setShowAdvancedDiscovery(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.98, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.98, opacity: 0 }}
              className="relative w-full max-w-xl bg-white border border-slate-900 shadow-2xl p-10"
            >
              <h2 className="text-2xl font-light text-slate-900 mb-8 border-b border-slate-100 pb-6">Descubrimiento Inteligente</h2>
              
              <div className="space-y-8 max-h-[60vh] overflow-y-auto pr-2">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Ubicación</label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {cities.map(loc => (
                      <button
                        key={loc}
                        title={loc}
                        type="button"
                        onClick={() => setDiscoveryLocation(loc)}
                        className={`px-3 py-2 text-[10px] font-medium border transition-all ${
                          discoveryLocation === loc
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
                        }`}
                      >
                        {loc}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <input
                      type="text"
                      className="flex-1 px-0 py-1 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 text-xs"
                      placeholder="Agregar ciudad..."
                      value={customCity}
                      onChange={e => setCustomCity(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && customCity.trim()) {
                          if (!cities.includes(customCity.trim())) {
                            setCities([...cities, customCity.trim()]);
                          }
                          setDiscoveryLocation(customCity.trim());
                          setCustomCity('');
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (customCity.trim() && !cities.includes(customCity.trim())) {
                          setCities([...cities, customCity.trim()]);
                          setDiscoveryLocation(customCity.trim());
                          setCustomCity('');
                        }
                      }}
                      className="text-[10px] font-bold text-slate-400 hover:text-slate-900 uppercase"
                    >+ Agregar</button>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Segmento de Mercado</label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {roles.map(role => {
                      const isSelected = selectedRoles.includes(role);
                      return (
                        <button
                          key={role}
                          title={role}
                          type="button"
                          onClick={() => {
                            if (isSelected) {
                              setSelectedRoles(selectedRoles.filter(r => r !== role));
                            } else {
                              setSelectedRoles([...selectedRoles, role]);
                            }
                          }}
                          className={`px-3 py-2 text-[10px] font-medium border transition-all ${
                            isSelected
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
                          }`}
                        >
                          {role}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <input
                      type="text"
                      className="flex-1 px-0 py-1 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 text-xs"
                      placeholder="Agregar segmento (ej. PMOs, Consultores, etc.)..."
                      value={newRole}
                      onChange={e => setNewRole(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && newRole.trim()) {
                          if (!roles.includes(newRole.trim())) {
                            setRoles([...roles, newRole.trim()]);
                          }
                          if (!selectedRoles.includes(newRole.trim())) {
                            setSelectedRoles([...selectedRoles, newRole.trim()]);
                          }
                          setNewRole('');
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (newRole.trim()) {
                          if (!roles.includes(newRole.trim())) {
                            setRoles([...roles, newRole.trim()]);
                          }
                          if (!selectedRoles.includes(newRole.trim())) {
                            setSelectedRoles([...selectedRoles, newRole.trim()]);
                          }
                          setNewRole('');
                        }
                      }}
                      className="text-[10px] font-bold text-slate-400 hover:text-slate-900 uppercase"
                    >+ Agregar</button>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Fuentes de Búsqueda</label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {sources.map(src => {
                      const isSelected = selectedSources.includes(src);
                      return (
                        <button
                          key={src}
                          type="button"
                          onClick={() => {
                            if (isSelected) {
                              setSelectedSources(selectedSources.filter(s => s !== src));
                            } else {
                              setSelectedSources([...selectedSources, src]);
                            }
                          }}
                          className={`px-3 py-2 text-[10px] font-medium border transition-all ${
                            isSelected
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
                          }`}
                        >
                          {src}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <input
                      type="text"
                      className="flex-1 px-0 py-1 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 text-xs"
                      placeholder="Agregar fuente (ej. LinkedIn, Yahoo, etc.)..."
                      value={newSource}
                      onChange={e => setNewSource(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && newSource.trim()) {
                          if (!sources.includes(newSource.trim())) {
                            setSources([...sources, newSource.trim()]);
                          }
                          if (!selectedSources.includes(newSource.trim())) {
                            setSelectedSources([...selectedSources, newSource.trim()]);
                          }
                          setNewSource('');
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (newSource.trim()) {
                          if (!sources.includes(newSource.trim())) {
                            setSources([...sources, newSource.trim()]);
                          }
                          if (!selectedSources.includes(newSource.trim())) {
                            setSelectedSources([...selectedSources, newSource.trim()]);
                          }
                          setNewSource('');
                        }
                      }}
                      className="text-[10px] font-bold text-slate-400 hover:text-slate-900 uppercase"
                    >+ Agregar</button>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Fuente adicional (URL o nombre)</label>
                  <input
                    type="text"
                    className="w-full px-0 py-2 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 transition-colors text-sm"
                    placeholder="Ej. https://directorio.com o nombre de directorio..."
                    value={customSource}
                    onChange={e => setCustomSource(e.target.value)}
                  />
                </div>
              </div>

              <div className="mt-12 flex items-center justify-between">
                <button
                  onClick={() => setShowAdvancedDiscovery(false)}
                  className="text-[10px] font-bold text-slate-400 hover:text-slate-900 uppercase tracking-widest transition-colors"
                >
                  Cerrar panel
                </button>
                <div className="flex items-center gap-2">
                  <button
                    disabled={selectedRoles.length === 0}
                    onClick={handleContinuousDiscovery}
                    className={`text-xs flex items-center gap-2 px-4 py-2 rounded transition-colors ${
                      isContinuousRunning
                        ? 'bg-red-600 text-white hover:bg-red-700'
                        : 'btn-secondary'
                    }`}
                  >
                    {isContinuousRunning ? <><Square size={14} /> Detener</> : <><Play size={14} /> Continuo</>}
                  </button>
                  <button
                    disabled={isDiscovering || selectedRoles.length === 0}
                    onClick={handleDiscovery}
                    className="btn-primary text-xs flex items-center gap-3"
                  >
                    {isDiscovering ? <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Search size={14} />}
                    {isDiscovering ? "Iniciando Agent Search..." : "Iniciar Prospección AI"}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Manual Add Modal */}
      <AnimatePresence>
        {isAdding && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              onClick={() => setIsAdding(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.98, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.98, opacity: 0 }}
              className="relative w-full max-w-xl bg-white border border-slate-900 shadow-2xl p-10"
            >
              <form onSubmit={handleAddProspect}>
                <h2 className="text-2xl font-light text-slate-900 mb-8 border-b border-slate-100 pb-6">Registro Manual</h2>
                
                <div className="space-y-6">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Nombre Completo</label>
                    <input 
                      autoFocus
                      required
                      className="w-full px-0 py-2 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 text-sm"
                      value={newProspect.name}
                      onChange={e => setNewProspect({...newProspect, name: e.target.value})}
                      placeholder="Identificador del prospecto"
                    />
                  </div>
                  
                  <div className="grid grid-cols-2 gap-8">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Categoría</label>
                      <select 
                        className="w-full px-0 py-2 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 text-xs"
                        value={newProspect.category}
                        onChange={e => setNewProspect({...newProspect, category: e.target.value as any})}
                      >
                        <option value="Salud">Salud</option>
                        <option value="Legal">Legal</option>
                        <option value="Inversión">Inversión</option>
                        <option value="Arquitectura">Arquitectura</option>
                        <option value="Profesionales">Profesionales</option>
                        <option value="Otros">Otros</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Contacto / Tel</label>
                      <input 
                        className="w-full px-0 py-2 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 text-sm"
                        value={newProspect.contact}
                        onChange={e => setNewProspect({...newProspect, contact: e.target.value})}
                        placeholder="+52 ..."
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-8">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Email</label>
                      <input 
                        className="w-full px-0 py-2 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 text-sm"
                        value={newProspect.email}
                        onChange={e => setNewProspect({...newProspect, email: e.target.value})}
                        placeholder="contacto@lead.com"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Ciudad / Zona</label>
                      <input 
                        className="w-full px-0 py-2 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 text-sm"
                        value={newProspect.location}
                        onChange={e => setNewProspect({...newProspect, location: e.target.value})}
                        placeholder="Ubicación"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Especialidad / Organización</label>
                    <input
                      className="w-full px-0 py-2 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 text-sm"
                      value={newProspect.specialty}
                      onChange={e => setNewProspect({...newProspect, specialty: e.target.value})}
                      placeholder="Cargo o institución médica/legal"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Notas</label>
                    <textarea
                      className="w-full px-0 py-2 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 text-sm resize-none"
                      rows={2}
                      value={newProspect.notes}
                      onChange={e => setNewProspect({...newProspect, notes: e.target.value})}
                      placeholder="Observaciones, contexto, etc."
                    />
                  </div>
                </div>

                <div className="mt-12 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setIsAdding(false)}
                    className="text-[10px] font-bold text-slate-400 hover:text-slate-900 uppercase tracking-widest transition-colors"
                  >
                    Descartar
                  </button>
                  <button
                    type="submit"
                    className="btn-primary text-xs"
                  >
                    Registrar Prospecto
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Prospect Detail Modal */}
      <AnimatePresence>
        {selectedProspect && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => { setSelectedProspect(null); setIsEditing(false); }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.98, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.98, opacity: 0 }}
              className="relative w-full max-w-lg bg-white border border-slate-900 shadow-2xl p-10 max-h-[85vh] overflow-y-auto"
            >
              <button
                onClick={() => { setSelectedProspect(null); setIsEditing(false); }}
                className="absolute top-4 right-4 text-slate-400 hover:text-slate-900"
              >
                <X size={18} />
              </button>

              {isEditing ? (
                /* Edit Mode */
                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Nombre</label>
                    <input className="w-full px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:border-slate-900" value={editForm.name || ''} onChange={e => setEditForm({...editForm, name: e.target.value})} />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Especialidad</label>
                    <input className="w-full px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:border-slate-900" value={editForm.specialty || ''} onChange={e => setEditForm({...editForm, specialty: e.target.value})} />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Categoría</label>
                      <select className="w-full px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:border-slate-900" value={editForm.category || 'Otros'} onChange={e => setEditForm({...editForm, category: e.target.value as any})}>
                        <option>Salud</option><option>Legal</option><option>Inversión</option><option>Arquitectura</option><option>Profesionales</option><option>Otros</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Ubicación</label>
                      <input className="w-full px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:border-slate-900" value={editForm.location || ''} onChange={e => setEditForm({...editForm, location: e.target.value})} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Teléfono</label>
                      <input className="w-full px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:border-slate-900" value={editForm.contact || ''} onChange={e => setEditForm({...editForm, contact: e.target.value})} />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Email</label>
                      <input className="w-full px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:border-slate-900" value={editForm.email || ''} onChange={e => setEditForm({...editForm, email: e.target.value})} />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Fuente</label>
                    <input className="w-full px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:border-slate-900" value={editForm.source || ''} onChange={e => setEditForm({...editForm, source: e.target.value})} />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">URL</label>
                    <input className="w-full px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:border-slate-900" value={editForm.url || ''} onChange={e => setEditForm({...editForm, url: e.target.value})} placeholder="https://..." />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Notas</label>
                    <textarea className="w-full px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:border-slate-900 resize-none" rows={3} value={editForm.notes || ''} onChange={e => setEditForm({...editForm, notes: e.target.value})} placeholder="Observaciones..." />
                  </div>
                  <div className="flex gap-2 pt-4 border-t border-slate-100">
                    <button onClick={handleSaveEdit} className="btn-primary flex-1 text-xs">Guardar</button>
                    <button onClick={() => setIsEditing(false)} className="btn-secondary flex-1 text-xs">Cancelar</button>
                  </div>
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={() => { handleManualQualify(selectedProspect!, 'qualified'); setIsEditing(false); }}
                      className="flex-1 flex items-center justify-center gap-2 text-xs px-3 py-2 border border-blue-200 text-blue-600 hover:bg-blue-50 rounded transition-colors"
                    >
                      <ThumbsUp size={14} /> Calificar
                    </button>
                    <button
                      onClick={() => { handleManualQualify(selectedProspect!, 'disqualified'); setIsEditing(false); }}
                      className="flex-1 flex items-center justify-center gap-2 text-xs px-3 py-2 border border-red-200 text-red-500 hover:bg-red-50 rounded transition-colors"
                    >
                      <ThumbsDown size={14} /> Descalificar
                    </button>
                  </div>
                </div>
              ) : (
                /* View Mode */
                <>
              <h2 className="text-xl font-medium text-slate-900 mb-1">{selectedProspect.name}</h2>
              <p className="text-xs text-slate-500 mb-6">{selectedProspect.specialty}</p>

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Categoría</span>
                    <span className="text-sm text-slate-900">{selectedProspect.category}</span>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Ubicación</span>
                    <span className="text-sm text-slate-900">{selectedProspect.location}</span>
                  </div>
                </div>

                <div className="border-t border-slate-100 pt-4">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-2">Contacto</span>
                  {(() => {
                    const quality = selectedProspect.contactQuality || detectContactQuality(selectedProspect.contact, selectedProspect.email || '');
                    return (
                      <div className={`p-3 rounded border ${
                        quality === 'qualified' ? 'border-blue-200 bg-blue-50' :
                        quality === 'disqualified' ? 'border-red-200 bg-red-50' :
                        quality === 'generic' ? 'border-amber-200 bg-amber-50' :
                        quality === 'direct' ? 'border-emerald-200 bg-emerald-50' :
                        'border-slate-200 bg-slate-50'
                      }`}>
                        <div className="flex items-center gap-2 mb-1">
                          {quality === 'qualified' && <ThumbsUp size={14} className="text-blue-500" />}
                          {quality === 'disqualified' && <ThumbsDown size={14} className="text-red-500" />}
                          {quality === 'generic' && <AlertTriangle size={14} className="text-amber-500" />}
                          {quality === 'direct' && <CheckCircle size={14} className="text-emerald-500" />}
                          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                            {quality === 'qualified' ? 'Calificado manualmente' :
                             quality === 'disqualified' ? 'Descalificado' :
                             quality === 'generic' ? 'Contacto genérico (conmutador/email general)' :
                             quality === 'direct' ? 'Contacto directo verificado' :
                             'Sin contacto'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-2">
                          <Phone size={12} className="text-slate-400" />
                          <span className="text-sm text-slate-900">{selectedProspect.contact || 'No disponible'}</span>
                        </div>
                        {selectedProspect.email && (
                          <div className="flex items-center gap-2 mt-1">
                            <ExternalLink size={12} className="text-slate-400" />
                            <span className="text-sm text-slate-900">{selectedProspect.email}</span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                <div className="border-t border-slate-100 pt-4">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Fuente</span>
                  <p className="text-xs text-slate-600 break-all">{selectedProspect.source}</p>
                </div>

                {selectedProspect.url && (
                  <div className="border-t border-slate-100 pt-4">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">URL</span>
                    <a href={selectedProspect.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline break-all">{selectedProspect.url}</a>
                  </div>
                )}

                {selectedProspect.notes && (
                  <div className="border-t border-slate-100 pt-4">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Notas</span>
                    <p className="text-xs text-slate-600 whitespace-pre-wrap">{selectedProspect.notes}</p>
                  </div>
                )}

                {/* Actions */}
                <div className="border-t border-slate-100 pt-4 flex gap-2">
                  <button
                    onClick={() => startEditing(selectedProspect)}
                    className="btn-secondary flex-1 flex items-center justify-center gap-2 text-xs"
                  >
                    <ExternalLink size={14} /> Editar
                  </button>
                  <button
                    onClick={() => downloadVCF(selectedProspect)}
                    className="btn-secondary flex-1 flex items-center justify-center gap-2 text-xs"
                  >
                    <Contact size={14} /> VCF
                  </button>
                  <button
                    disabled={isEnriching}
                    onClick={() => handleEnrich(selectedProspect)}
                    className="btn-secondary flex-1 flex items-center justify-center gap-2 text-xs"
                  >
                    {isEnriching ? (
                      <><div className="w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" /> Buscando...</>
                    ) : (
                      <><RefreshCw size={14} /> OSINT</>
                    )}
                  </button>
                  <button
                    onClick={() => handleDeleteProspect(selectedProspect)}
                    className="flex items-center justify-center gap-2 text-xs px-3 py-2 border border-red-200 text-red-500 hover:bg-red-50 rounded transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                  {enrichResult && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="mt-4 p-4 bg-slate-50 border border-slate-200 rounded space-y-3"
                    >
                      <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Resultado de búsqueda</h4>

                      {enrichResult.direct_phone && (
                        <div>
                          <span className="text-[10px] text-slate-400 block">Teléfono directo:</span>
                          <span className="text-sm font-medium text-slate-900">{enrichResult.direct_phone}</span>
                          {enrichResult.phone_source && (
                            <span className="text-[10px] text-slate-400 block">Fuente: {enrichResult.phone_source}</span>
                          )}
                        </div>
                      )}

                      {enrichResult.direct_email && (
                        <div>
                          <span className="text-[10px] text-slate-400 block">Email directo:</span>
                          <span className="text-sm font-medium text-slate-900">{enrichResult.direct_email}</span>
                          {enrichResult.email_source && (
                            <span className="text-[10px] text-slate-400 block">Fuente: {enrichResult.email_source}</span>
                          )}
                        </div>
                      )}

                      {enrichResult.confidence && (
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-400">Confianza:</span>
                          <span className={`text-[10px] font-bold uppercase ${
                            enrichResult.confidence === 'alta' ? 'text-emerald-600' :
                            enrichResult.confidence === 'media' ? 'text-amber-600' :
                            'text-red-500'
                          }`}>{enrichResult.confidence}</span>
                        </div>
                      )}

                      {enrichResult.notes && (
                        <p className="text-[10px] text-slate-500">{enrichResult.notes}</p>
                      )}

                      {enrichResult.osint_sources?.length > 0 && (
                        <div>
                          <span className="text-[10px] text-slate-400 block mb-1">Fuentes OSINT ({enrichResult.osint_sources.length}):</span>
                          {enrichResult.osint_sources.map((src: string, i: number) => (
                            <a key={i} href={src} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-500 hover:underline block truncate">{src}</a>
                          ))}
                        </div>
                      )}

                      {(enrichResult.direct_phone || enrichResult.direct_email) && (
                        <button
                          onClick={() => applyEnrichment(selectedProspect, enrichResult.direct_phone, enrichResult.direct_email)}
                          className="btn-primary w-full text-xs mt-2"
                        >
                          Aplicar contacto directo
                        </button>
                      )}

                      {!enrichResult.direct_phone && !enrichResult.direct_email && (
                        <p className="text-xs text-slate-500 italic">No se encontró un contacto más directo.</p>
                      )}
                    </motion.div>
                  )}
              </div>
                </>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Search Person Modal */}
      <AnimatePresence>
        {showSearchPerson && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSearchPerson(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.98, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.98, opacity: 0 }}
              className="relative w-full max-w-md bg-white border border-slate-900 shadow-2xl p-10"
            >
              <h2 className="text-2xl font-light text-slate-900 mb-2">Buscar Persona</h2>
              <p className="text-xs text-slate-500 mb-8">Ingresa el nombre y la ciudad. Se creará el prospecto y se ejecutará OSINT automáticamente para localizar sus datos de contacto.</p>

              <div className="space-y-6">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Nombre completo</label>
                  <input
                    autoFocus
                    className="w-full px-0 py-2 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 text-sm"
                    value={searchPersonForm.name}
                    onChange={e => setSearchPersonForm({ ...searchPersonForm, name: e.target.value })}
                    placeholder="Dr. Juan Pérez López"
                    onKeyDown={e => { if (e.key === 'Enter' && searchPersonForm.name.trim()) handleSearchPerson(); }}
                  />
                </div>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Ciudad</label>
                    <input
                      className="w-full px-0 py-2 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 text-sm"
                      value={searchPersonForm.location}
                      onChange={e => setSearchPersonForm({ ...searchPersonForm, location: e.target.value })}
                      placeholder="Ciudad de México"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Especialidad (opcional)</label>
                    <input
                      className="w-full px-0 py-2 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 text-sm"
                      value={searchPersonForm.specialty}
                      onChange={e => setSearchPersonForm({ ...searchPersonForm, specialty: e.target.value })}
                      placeholder="Cardiólogo, Abogado..."
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Categoría</label>
                  <select
                    className="w-full px-0 py-2 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 text-xs"
                    value={searchPersonForm.category}
                    onChange={e => setSearchPersonForm({ ...searchPersonForm, category: e.target.value as any })}
                  >
                    <option value="Salud">Salud</option>
                    <option value="Legal">Legal</option>
                    <option value="Inversión">Inversión</option>
                    <option value="Arquitectura">Arquitectura</option>
                    <option value="Profesionales">Profesionales</option>
                    <option value="Otros">Otros</option>
                  </select>
                </div>
              </div>

              <div className="mt-10 flex items-center justify-between">
                <button
                  onClick={() => setShowSearchPerson(false)}
                  className="text-[10px] font-bold text-slate-400 hover:text-slate-900 uppercase tracking-widest transition-colors"
                >
                  Cancelar
                </button>
                <button
                  disabled={searchPersonLoading || !searchPersonForm.name.trim()}
                  onClick={handleSearchPerson}
                  className="btn-primary text-xs flex items-center gap-2 bg-blue-600 hover:bg-blue-700 border-blue-600"
                >
                  {searchPersonLoading ? (
                    <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Buscando...</>
                  ) : (
                    <><Search size={14} /> Buscar y localizar</>
                  )}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* User Admin Modal */}
      <AnimatePresence>
        {showUserAdmin && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => { setShowUserAdmin(false); setEditingUser(null); setUserError(''); }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.98, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.98, opacity: 0 }}
              className="relative w-full max-w-2xl bg-white border border-slate-900 shadow-2xl p-8 max-h-[85vh] overflow-y-auto"
            >
              <button
                onClick={() => { setShowUserAdmin(false); setEditingUser(null); setUserError(''); }}
                className="absolute top-4 right-4 text-slate-400 hover:text-slate-900"
              >
                <X size={18} />
              </button>

              <h2 className="text-lg font-medium text-slate-900 mb-6 flex items-center gap-2">
                <Settings size={20} /> Administrar Usuarios
              </h2>

              {/* User Form */}
              <div className="bg-slate-50 border border-slate-200 rounded p-4 mb-6 space-y-3">
                <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  {editingUser ? `Editando: ${editingUser.username}` : 'Nuevo usuario'}
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Usuario</label>
                    <input
                      className="w-full px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:border-slate-900"
                      value={userForm.username}
                      onChange={e => setUserForm({...userForm, username: e.target.value})}
                      placeholder="nombre.usuario"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">
                      Contraseña {editingUser && '(dejar vacío para no cambiar)'}
                    </label>
                    <input
                      type="password"
                      className="w-full px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:border-slate-900"
                      value={userForm.password}
                      onChange={e => setUserForm({...userForm, password: e.target.value})}
                      placeholder={editingUser ? '••••••' : 'contraseña'}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Nombre</label>
                    <input
                      className="w-full px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:border-slate-900"
                      value={userForm.displayName}
                      onChange={e => setUserForm({...userForm, displayName: e.target.value})}
                      placeholder="Nombre completo"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Rol</label>
                    <select
                      className="w-full px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:border-slate-900"
                      value={userForm.role}
                      onChange={e => setUserForm({...userForm, role: e.target.value})}
                    >
                      <option value="user">Usuario</option>
                      <option value="admin">Administrador</option>
                    </select>
                  </div>
                </div>
                {userError && <p className="text-xs text-red-500">{userError}</p>}
                <div className="flex gap-2">
                  <button onClick={handleSaveUser} className="btn-primary text-xs flex items-center gap-2">
                    <UserPlus size={14} /> {editingUser ? 'Guardar cambios' : 'Crear usuario'}
                  </button>
                  {editingUser && (
                    <button
                      onClick={() => { setEditingUser(null); setUserForm({ username: '', password: '', displayName: '', role: 'user' }); setUserError(''); }}
                      className="btn-secondary text-xs"
                    >
                      Cancelar
                    </button>
                  )}
                </div>
              </div>

              {/* User List */}
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Usuario</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Nombre</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Rol</th>
                    <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {userList.map(u => (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 text-sm text-slate-900 font-medium">{u.username}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{u.displayName}</td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded ${
                          u.role === 'admin' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'
                        }`}>
                          {u.role === 'admin' ? 'Admin' : 'Usuario'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => { setEditingUser(u); setUserForm({ username: u.username, password: '', displayName: u.displayName, role: u.role }); setUserError(''); }}
                            className="p-1.5 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded transition-colors"
                            title="Editar"
                          >
                            <ExternalLink size={14} />
                          </button>
                          {u.id !== 'admin' && (
                            <button
                              onClick={() => handleDeleteUser(u.id)}
                              className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                              title="Eliminar"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

