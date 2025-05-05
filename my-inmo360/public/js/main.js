// main.js
document.addEventListener('DOMContentLoaded', () => {
    const departamentoSelect = document.getElementById('departamento');
    const municipioSelect = document.getElementById('municipio');
    const zonaSelect = document.getElementById('zona');
  
    if(departamentoSelect) {
      departamentoSelect.addEventListener('change', async () => {
        const departamento = departamentoSelect.value;
        municipioSelect.innerHTML = '<option value="">Cargando...</option>';
        zonaSelect.innerHTML = '<option value="">Selecciona primero un municipio</option>';
  
        if (!departamento) {
          municipioSelect.innerHTML = '<option value="">Selecciona primero un departamento</option>';
          return;
        }
  
        try {
          const res = await fetch(`/municipios?departamento=${encodeURIComponent(departamento)}`);
          const data = await res.json();
          municipioSelect.innerHTML = '<option value="">Selecciona un municipio</option>';
          data.forEach(m => {
            const option = document.createElement('option');
            option.value = m.nombre;
            option.textContent = m.nombre;
            municipioSelect.appendChild(option);
          });
        } catch (error) {
          console.error(error);
        }
      });
    }
  
    if(municipioSelect) {
      municipioSelect.addEventListener('change', async () => {
        const departamento = departamentoSelect.value;
        const municipio = municipioSelect.value;
        zonaSelect.innerHTML = '<option value="">Cargando...</option>';
  
        if (!municipio) {
          zonaSelect.innerHTML = '<option value="">Selecciona primero un municipio</option>';
          return;
        }
  
        try {
          const res = await fetch(`/zonas?departamento=${encodeURIComponent(departamento)}&municipio=${encodeURIComponent(municipio)}`);
          const data = await res.json();
          zonaSelect.innerHTML = '<option value="">Selecciona una zona</option>';
          data.forEach(z => {
            const option = document.createElement('option');
            option.value = z;
            option.textContent = z;
            zonaSelect.appendChild(option);
          });
        } catch (error) {
          console.error(error);
        }
      });
    }
  });
  