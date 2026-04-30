/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import * as XLSX from 'xlsx';
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
  ChevronRight,
  TrendingUp,
  Briefcase
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
  createdAt?: any;
}

const INITIAL_PROSPECTS: Prospect[] = [];

export default function App() {
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('All');
  const [selectedRoles, setSelectedRoles] = useState<string[]>(['Doctores']);
  const [discoveryLocation, setDiscoveryLocation] = useState<string>('Mérida, Yucatán');
  const [isAdding, setIsAdding] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [clipboardText, setClipboardText] = useState('');
  const [showClipboard, setShowClipboard] = useState(false);
  const [customSource, setCustomSource] = useState('');
  const [showAdvancedDiscovery, setShowAdvancedDiscovery] = useState(false);

  // Sync with SQLite API
  useEffect(() => {
    const fetchProspects = async () => {
      try {
        const response = await fetch('/api/prospects');
        const data = await response.json();
        setProspects(data);
      } catch (error) {
        console.error("Fetch failed", error);
      }
    };

    fetchProspects();
  }, []);

  const saveToApi = async (newLeads: Partial<Prospect>[]) => {
    try {
      const response = await fetch('/api/prospects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newLeads)
      });
      if (response.ok) {
        // Refresh local state
        const refreshResponse = await fetch('/api/prospects');
        const data = await refreshResponse.json();
        setProspects(data);
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
    source: ''
  });

  const filteredProspects = useMemo(() => {
    return prospects.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                            p.specialty.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesCategory = activeCategory === 'All' || p.category === activeCategory;
      return matchesSearch && matchesCategory;
    });
  }, [prospects, searchTerm, activeCategory]);

  const handleDiscovery = async () => {
    if (selectedRoles.length === 0) return;
    setIsDiscovering(true);
    try {
      const data = await discoverProspects(selectedRoles, discoveryLocation, customSource);
      if (data.leads) {
        // Map the AI leads into our specific categories for reliable filtering
        const mappedLeads = data.leads.map((l: any) => {
          let category: Prospect['category'] = 'Otros';
          const lowerLeadsCat = (l.category || '').toLowerCase();
          const combined = (selectedRoles.join(' ') + ' ' + lowerLeadsCat + ' ' + (l.specialty || '')).toLowerCase();

          if (combined.includes('doctor') || combined.includes('salud') || combined.includes('dentista') || combined.includes('clínica')) category = 'Salud';
          else if (combined.includes('abogado') || combined.includes('legal') || combined.includes('notario')) category = 'Legal';
          else if (combined.includes('invers') || combined.includes('empresario') || combined.includes('dueño') || combined.includes('socio')) category = 'Inversión';
          else if (combined.includes('arq') || combined.includes('ing') || combined.includes('const') || combined.includes('civil')) category = 'Arquitectura';
          else if (combined.includes('profesional') || combined.includes('especialista') || combined.includes('consult')) category = 'Profesionales';
          
          return { ...l, category };
        });
        await saveToApi(mappedLeads);
        setShowAdvancedDiscovery(false);
        setCustomSource('');
      }
    } catch (error) {
      console.error("Discovery failed", error);
    } finally {
      setIsDiscovering(false);
    }
  };

  const handleExtraction = async () => {
    if (!clipboardText) return;
    setIsDiscovering(true);
    try {
      const data = await extractFromText(clipboardText);
      if (data.leads) {
        // Map extracted leads to current category or detect if possible
        const mappedLeads = data.leads.map((l: any) => {
          let category: Prospect['category'] = (activeCategory === 'All' ? 'Otros' : activeCategory) as any;
          
          // Re-validate category if "All" was selected or if lead content suggests otherwise
          const combined = ((l.specialty || '') + ' ' + (l.category || '')).toLowerCase();
          if (combined.includes('doctor') || combined.includes('dentista')) category = 'Salud';
          if (combined.includes('abogado') || combined.includes('notario')) category = 'Legal';
          if (combined.includes('invers') || combined.includes('dueño')) category = 'Inversión';
          if (combined.includes('arq') || combined.includes('ing')) category = 'Arquitectura';

          return { ...l, category };
        });
        await saveToApi(mappedLeads);
        setClipboardText('');
        setShowClipboard(false);
      }
    } catch (error) {
      console.error("Extraction failed", error);
    } finally {
      setIsDiscovering(false);
    }
  };

  const exportToExcel = () => {
    const data = prospects.map(p => ({
      'Nombre': p.name,
      'Especialidad': p.specialty,
      'Ubicación': p.location,
      'Contacto': p.contact,
      'Email': p.email || 'N/A',
      'Categoría': p.category,
      'Fuente': p.source
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Prospectos");
    
    // Auto-size columns
    const colWidths = [
      { wch: 30 }, // Nombre
      { wch: 30 }, // Especialidad
      { wch: 30 }, // Ubicación
      { wch: 20 }, // Contacto
      { wch: 25 }, // Email
      { wch: 15 }, // Categoría
      { wch: 20 }, // Fuente
    ];
    worksheet['!cols'] = colWidths;

    XLSX.writeFile(workbook, "prospectos_yucatan_inmuebles.xlsx");
  };

  const exportToCSV = () => {
    const headers = ['Nombre', 'Especialidad', 'Ubicación', 'Contacto', 'Email', 'Categoría', 'Fuente'];
    // Quoting values and using semicolon for Excel compatibility in Spanish regions
    const rows = prospects.map(p => [
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
    link.setAttribute("download", "prospectos_yucatan_inmuebles.csv");
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
      source: newProspect.source || 'Manual'
    }]);

    setNewProspect({ name: '', specialty: '', location: '', contact: '', email: '', category: 'Salud', source: '' });
    setIsAdding(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      {/* Sidebar / Navigation */}
      <nav className="fixed top-0 left-0 h-screen w-16 md:w-64 bg-white border-r border-slate-200 hidden sm:flex flex-col z-20">
        <div className="p-6 border-b border-slate-100 flex items-center gap-3">
          <div className="w-8 h-8 bg-slate-900 rounded flex items-center justify-center text-white">
            <TrendingUp size={16} />
          </div>
          <span className="font-semibold text-sm hidden md:block tracking-tight text-slate-900 uppercase">Prospect CRM</span>
        </div>

        <div className="flex-1 px-3 py-6 space-y-1">
          {['All', 'Salud', 'Legal', 'Inversión', 'Arquitectura', 'Profesionales', 'Otros'].map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded transition-all duration-200 ${
                activeCategory === cat 
                ? 'bg-slate-900 text-white font-medium' 
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <div className="w-5 flex justify-center">
                {cat === 'All' && <Users size={18} />}
                {cat === 'Salud' && <Stethoscope size={18} />}
                {cat === 'Legal' && <Scale size={18} />}
                {cat === 'Inversión' && <TrendingUp size={18} />}
                {cat === 'Arquitectura' && <HardHat size={18} />}
                {cat === 'Profesionales' && <Briefcase size={18} />}
                {cat === 'Otros' && <Plus size={18} />}
              </div>
              <span className="hidden md:block text-xs font-medium">{cat === 'All' ? 'Todos los registros' : cat}</span>
            </button>
          ))}
        </div>

        <div className="p-6 border-t border-slate-100 space-y-4">
          <div className="hidden md:block">
            <div className="flex justify-between items-end mb-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Meta Semanal</span>
              <span className="text-[10px] font-mono text-slate-500">{prospects.length}%</span>
            </div>
            <div className="w-full bg-slate-100 h-1 rounded-full overflow-hidden">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(prospects.length, 100)}%` }}
                className="bg-slate-900 h-full"
              />
            </div>
          </div>
        </div>
      </nav>

      <main className="sm:ml-16 md:ml-64 p-6 md:p-10 transition-all duration-500">
        <header className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 mb-12">
          <div>
            <div className="flex items-center gap-2 text-slate-400 text-[10px] font-bold uppercase tracking-[0.2em] mb-2">
              <span>Mérida & Nacional</span>
              <span className="w-1 h-1 bg-slate-300 rounded-full"></span>
              <span>CRM v2.0</span>
            </div>
            <h1 className="text-4xl font-light text-slate-900 tracking-tight">Prospección Inmobiliaria</h1>
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
              disabled={isDiscovering}
              onClick={() => setShowAdvancedDiscovery(true)}
              className="btn-secondary flex items-center gap-2 text-xs"
            >
              {isDiscovering ? <div className="w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" /> : <TrendingUp size={14} />}
              Descubrimiento AI
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
                <p className="text-slate-500 text-sm mb-6">Pega texto de directorios o redes sociales para extraer leads automáticamente.</p>
                <textarea 
                  className="w-full h-32 bg-slate-50 border border-slate-200 p-4 text-slate-900 text-sm focus:outline-none focus:border-slate-900 transition-colors resize-none"
                  placeholder="Contenido a procesar..."
                  value={clipboardText}
                  onChange={(e) => setClipboardText(e.target.value)}
                />
                <div className="mt-6 flex justify-end gap-3">
                  <button onClick={() => setShowClipboard(false)} className="text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-slate-900 transition-colors">Cancelar</button>
                  <button 
                    disabled={isDiscovering || !clipboardText}
                    onClick={handleExtraction}
                    className="btn-primary text-xs flex items-center gap-2 disabled:opacity-50"
                  >
                    {isDiscovering ? "Procesando..." : "Extraer Información"}
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-px bg-slate-200 border border-slate-200 mb-12 shadow-sm rounded-lg overflow-hidden">
          {[
            { label: 'Registros', value: prospects.length },
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

        {/* Search Bar */}
        <div className="relative mb-8 group">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-slate-900 transition-colors" size={18} />
          <input 
            type="text" 
            placeholder="Filtrar por nombre, especialidad o ubicación..."
            className="w-full pl-12 pr-4 py-3 bg-white border border-slate-200 focus:outline-none focus:border-slate-900 transition-all text-sm text-slate-900"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        {/* Prospect Table */}
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden mb-12">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="px-6 py-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Identidad</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Especialidad / Fuente</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Ubicación</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Contacto</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest text-right">Detalle</th>
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
                      className="hover:bg-slate-50 transition-colors group cursor-default"
                    >
                      <td className="px-6 py-4">
                        <div>
                          <p className="font-medium text-sm text-slate-900">{prospect.name}</p>
                          <div className="flex items-center gap-1.5 mt-1">
                            <div className={`w-1.5 h-1.5 rounded-full ${
                              prospect.category === 'Salud' ? 'bg-rose-400' :
                              prospect.category === 'Legal' ? 'bg-amber-400' :
                              prospect.category === 'Inversión' ? 'bg-indigo-400' :
                              prospect.category === 'Arquitectura' ? 'bg-emerald-400' :
                              'bg-slate-300'
                            }`} />
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">{prospect.category}</span>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <p className="text-xs text-slate-600">{prospect.specialty}</p>
                        <p className="text-[10px] font-mono text-slate-400 mt-1">{prospect.source}</p>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1.5 text-xs text-slate-500">
                          <MapPin size={12} className="text-slate-300" />
                          {prospect.location}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col gap-0.5">
                          <p className="text-xs font-medium text-slate-900">{prospect.contact || '-'}</p>
                          <p className="text-[10px] text-slate-400">{prospect.email || ''}</p>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <button className="p-1 px-2 text-[10px] font-bold text-slate-300 group-hover:text-slate-900 transition-colors">
                          VIEW
                        </button>
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
        </div>

        {/* Resources Grid */}
        <section className="mt-20">
          <div className="flex items-center gap-4 mb-8">
            <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-slate-900">Estrategia de Prospección</h2>
            <div className="h-px flex-1 bg-slate-200" />
          </div>
          
          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                id: '01',
                title: 'Doctoralia Network',
                link: 'https://www.doctoralia.com.mx/merida',
                desc: 'Minería de perfiles médicos de alto nivel en zonas residenciales.'
              },
              {
                id: '02',
                title: 'Professional Hubs',
                link: 'https://www.seccionamarilla.com.mx',
                desc: 'Extracción de despachos legales y firmas de arquitectura locales.'
              },
              {
                id: '03',
                title: 'Enterprise Search',
                link: '#',
                desc: 'Identificación de inversionistas y directivos de cámaras empresariales.'
              }
            ].map((resource, i) => (
              <div key={i} className="group cursor-pointer">
                <div className="text-slate-900 font-mono text-xs mb-3">{resource.id}</div>
                <h3 className="font-semibold text-slate-900 mb-2 group-hover:underline underline-offset-4">{resource.title}</h3>
                <p className="text-xs text-slate-500 leading-relaxed mb-4">{resource.desc}</p>
                <a href={resource.link} target="_blank" rel="noreferrer" className="text-[10px] font-bold text-slate-400 hover:text-slate-900 transition-colors tracking-widest uppercase">Launch Source</a>
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
              
              <div className="space-y-8">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Ubicación Geográfica</label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {['Mérida, Yucatán', 'Ciudad de México', 'Monterrey', 'Guadalajara', 'Querétaro', 'Todo México'].map(loc => (
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
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Segmento de Mercado</label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {['Doctores', 'Abogados', 'Notarios', 'Inversionistas', 'Empresarios', 'Ingenieros', 'Arquitectos', 'Candidatos', 'Especialistas'].map(role => {
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
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Fuente Alternativa</label>
                  <input 
                    type="text"
                    className="w-full px-0 py-2 bg-transparent border-b border-slate-200 focus:outline-none focus:border-slate-900 transition-colors text-sm"
                    placeholder="Ej. LinkedIn, Directorio Médico..."
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
                <button 
                  disabled={isDiscovering || selectedRoles.length === 0}
                  onClick={handleDiscovery}
                  className="btn-primary text-xs flex items-center gap-3"
                >
                  {isDiscovering ? <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Search size={14} />}
                  {isDiscovering ? "Iniciando Agent Search..." : "Iniciar Prospección AI"}
                </button>
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
    </div>
  );
}

