export let currentUser = null;

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    if (response.ok) throw new Error('เซิร์ฟเวอร์ตอบกลับข้อมูลไม่ถูกต้อง');
  }
  if (!response.ok) throw new Error(payload.error?.message || `คำขอล้มเหลว (HTTP ${response.status})`);
  return payload;
}

function showLogin(message = '') {
  const loginScreen = document.getElementById('loginScreen');
  const shell = document.querySelector('.shell');
  if (loginScreen) loginScreen.hidden = false;
  if (shell) shell.hidden = true;
  const messageNode = document.getElementById('loginMessage');
  if (messageNode && message) {
    messageNode.hidden = false;
    messageNode.textContent = message;
  }
}

window.addEventListener('dashboard:unauthorized', () => showLogin('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง'));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

function localInputDate(isoDate) {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function initializeUserManager() {
  const button = document.getElementById('userManageBtn');
  const panel = document.getElementById('userManagePanel');
  const form = document.getElementById('userForm');
  const listBody = document.getElementById('userListBody');
  const cameraSelect = document.getElementById('userCameraSelect');
  if (!button || !panel || !form || !listBody || currentUser?.role !== 'admin') return;

  button.hidden = false;
  const formMessage = document.getElementById('userFormMessage');
  let users = [];
  let cameras = [];
  const showFormError = (message = '') => {
    formMessage.hidden = !message;
    formMessage.textContent = message;
  };

  const renderUsers = () => {
    listBody.innerHTML = users.map((user) => `<tr>
      <td>${escapeHtml(user.username)}</td>
      <td>${user.role === 'admin' ? 'Admin' : 'ผู้ใช้'}</td>
      <td>${user.expiresAt ? escapeHtml(new Date(user.expiresAt).toLocaleString()) : 'ไม่หมดอายุ'}</td>
      <td><button class="btn btn-ghost btn-sm" type="button" data-edit-user="${escapeHtml(user.id)}">แก้ไข</button>
      <button class="btn btn-ghost btn-sm" type="button" data-delete-user="${escapeHtml(user.id)}">ลบ</button></td>
    </tr>`).join('');
  };

  const reload = async () => {
    [users, cameras] = await Promise.all([request('/api/admin/users'), request('/api/cameras')]);
    cameraSelect.innerHTML = cameras.map((camera) => {
      const id = String(camera.camera_id);
      return `<option value="${escapeHtml(id)}">${escapeHtml(camera.camera_name || id)} · ${escapeHtml(id)}</option>`;
    }).join('');
    renderUsers();
  };

  const resetForm = () => {
    form.reset();
    form.elements.id.value = '';
    form.elements.maxGraphs.value = '1';
    form.elements.role.value = 'user';
    form.elements.role.disabled = false;
    form.querySelectorAll('[name="pages"]').forEach((checkbox) => { checkbox.checked = false; });
    form.querySelectorAll('[name="pages"]').forEach((checkbox) => { checkbox.disabled = false; });
    form.elements.password.required = true;
    cameraSelect.disabled = false;
    form.elements.maxGraphs.disabled = false;
    showFormError('');
  };
  const editUser = (user) => {
    form.elements.id.value = user.id;
    form.elements.username.value = user.username;
    form.elements.password.value = '';
    form.elements.password.required = false;
    form.elements.role.value = user.role;
    form.elements.expiresAt.value = localInputDate(user.expiresAt);
    form.elements.maxGraphs.value = String(user.maxGraphs);
    form.querySelectorAll('[name="pages"]').forEach((checkbox) => {
      checkbox.checked = user.pages.includes(checkbox.value);
    });
    [...cameraSelect.options].forEach((option) => { option.selected = user.cameras.includes(option.value); });
    form.elements.role.dispatchEvent(new Event('change'));
    showFormError('');
  };

  button.addEventListener('click', async () => {
    panel.hidden = false;
    try {
      await reload();
    } catch (error) {
      showFormError(error.message);
    }
  });
  document.getElementById('closeUserManageBtn')?.addEventListener('click', () => { panel.hidden = true; });
  document.getElementById('cancelUserEditBtn')?.addEventListener('click', resetForm);
  panel.addEventListener('click', (event) => {
    if (event.target === panel) panel.hidden = true;
  });
  form.elements.role.addEventListener('change', () => {
    const admin = form.elements.role.value === 'admin';
    form.elements.maxGraphs.value = admin ? '20' : form.elements.maxGraphs.value || '1';
    form.querySelectorAll('[name="pages"]').forEach((checkbox) => {
      checkbox.checked = admin || checkbox.checked;
      checkbox.disabled = admin;
    });
    cameraSelect.disabled = admin;
    form.elements.maxGraphs.disabled = admin;
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = form.elements.id.value;
    const payload = {
      username: form.elements.username.value,
      password: form.elements.password.value,
      role: form.elements.role.value,
      expiresAt: form.elements.expiresAt.value
        ? new Date(form.elements.expiresAt.value).toISOString() : null,
      maxGraphs: Number(form.elements.maxGraphs.value),
      pages: [...form.querySelectorAll('[name="pages"]:checked')].map((checkbox) => checkbox.value),
      cameras: [...cameraSelect.selectedOptions].map((option) => option.value),
    };
    try {
      const path = id ? `/api/admin/users/${encodeURIComponent(id)}` : '/api/admin/users';
      await request(path, { method: id ? 'PUT' : 'POST', body: payload });
      resetForm();
      await reload();
    } catch (error) {
      showFormError(error.message);
    }
  });
  listBody.addEventListener('click', async (event) => {
    const editButton = event.target.closest('[data-edit-user]');
    const deleteButton = event.target.closest('[data-delete-user]');
    if (editButton) {
      const user = users.find((item) => item.id === editButton.dataset.editUser);
      if (user) editUser(user);
      return;
    }
    if (deleteButton) {
      const user = users.find((item) => item.id === deleteButton.dataset.deleteUser);
      if (!user || !window.confirm(`ยืนยันลบบัญชี ${user.username}?`)) return;
      try {
        await request(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
        await reload();
      } catch (error) {
        showFormError(error.message);
      }
    }
  });
};

const authReady = (async () => {
  const form = document.getElementById('loginForm');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = document.getElementById('loginMessage');
    message.hidden = true;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await request('/api/auth/login', {
        method: 'POST',
        body: { username: form.elements.username.value, password: form.elements.password.value },
      });
      location.reload();
    } catch (error) {
      message.textContent = error.message;
      message.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    try {
      await request('/api/auth/logout', { method: 'POST' });
      location.reload();
    } catch (error) {
      showLogin(`ออกจากระบบไม่สำเร็จ: ${error.message}`);
    }
  });

  try {
    const session = await request('/api/auth/me');
    if (!session.authenticated) {
      showLogin(session.setupRequired
        ? 'ยังไม่ได้ตั้งค่า admin: กำหนด ADMIN_USERNAME และ ADMIN_PASSWORD (อย่างน้อย 12 ตัวอักษร) ใน .env แล้วเริ่มเซิร์ฟเวอร์ใหม่'
        : '');
      return false;
    }
    currentUser = session.user;
    document.getElementById('loginScreen').hidden = true;
    document.querySelector('.shell').hidden = false;
    document.getElementById('currentUsername').textContent = currentUser.username;
    initializeUserManager();
    return true;
  } catch (error) {
    showLogin(`ตรวจสอบการเข้าสู่ระบบไม่สำเร็จ: ${error.message}`);
    return false;
  }
})();

export { authReady };
