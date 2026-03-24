async function exchangeCode({ code, redirectUri, clientId, clientSecret }) {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });

  const res = await fetch(`https://oauth.vk.com/access_token?${params.toString()}`);
  const data = await res.json();

  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  return {
    accessToken: data.access_token,
    userId: data.user_id,
  };
}

async function fetchUserProfile(accessToken) {
  const params = new URLSearchParams({
    access_token: accessToken,
    fields: 'first_name,last_name',
    v: '5.131',
  });

  const res = await fetch(`https://api.vk.com/method/users.get?${params.toString()}`);
  const data = await res.json();

  if (data.error) {
    throw new Error(data.error.error_msg || 'VK API error');
  }

  const user = data.response[0];
  return {
    vkId: user.id,
    firstName: user.first_name,
    lastName: user.last_name,
  };
}

module.exports = { exchangeCode, fetchUserProfile };
