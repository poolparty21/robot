/**
 * Supabase client (service role) for admin-level operations like Storage.
 * Use only server-side — never expose the service role key to the client.
 */
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;

function getSupabase() {
  if (!supabase) {
    if (!supabaseUrl || !supabaseServiceKey) {
      console.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — storage will be unavailable');
      return null;
    }
    supabase = createClient(supabaseUrl, supabaseServiceKey);
  }
  return supabase;
}

/**
 * Upload a file buffer to Supabase Storage.
 * @param {string} bucket - Bucket name
 * @param {string} path - File path within the bucket
 * @param {Buffer} buffer - File data
 * @param {string} contentType - MIME type
 * @returns {Promise<{publicUrl: string, error: Error|null}>}
 */
async function uploadFile(bucket, path, buffer, contentType) {
  const client = getSupabase();
  if (!client) {
    return { publicUrl: null, error: new Error('Supabase not configured') };
  }

  const { data, error } = await client.storage
    .from(bucket)
    .upload(path, buffer, {
      contentType,
      upsert: true,
    });

  if (error) {
    return { publicUrl: null, error };
  }

  // Get the public URL
  const { data: urlData } = client.storage
    .from(bucket)
    .getPublicUrl(path);

  return { publicUrl: urlData.publicUrl, error: null };
}

/**
 * Delete a file from Supabase Storage.
 */
async function deleteFile(bucket, path) {
  const client = getSupabase();
  if (!client) return { error: new Error('Supabase not configured') };

  const { error } = await client.storage.from(bucket).remove([path]);
  return { error };
}

module.exports = { uploadFile, deleteFile, getSupabase };
