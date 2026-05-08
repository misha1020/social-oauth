async function fetchUserProfile(accessToken) {
  let res;
  try {
    res = await fetch('https://login.yandex.ru/info?format=json', {
      method: 'GET',
      headers: {
        Authorization: `OAuth ${accessToken}`,
      },
    });
  } catch (err) {
    throw new Error(`yandex_unreachable: ${err.message}`);
  }

  if (!res.ok) {
    let body = {};
    try { body = await res.json(); } catch (_) {}
    throw new Error(`yandex_token_invalid: ${body.error || res.status}`);
  }

  const data = await res.json();

  return {
    provider: 'yandex',
    providerId: String(data.id),
    firstName: data.first_name || '',
    lastName: data.last_name || '',
    ...(data.default_email ? { email: data.default_email } : {}),
    ...(data.default_avatar_id ? { avatarId: data.default_avatar_id } : {}),
  };
}

module.exports = { fetchUserProfile };
