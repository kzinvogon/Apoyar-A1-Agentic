# My Profile API Documentation

## Overview
The My Profile feature allows Customers and Experts to view and update their profile information.

## API Endpoints

### GET `/api/auth/profile`
Get the current user's profile information.

**Headers:**
```
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "profile": {
    "id": 1,
    "username": "admin",
    "email": "admin@apoyar.com",
    "full_name": "Apoyar Administrator",
    "role": "admin",
    "phone": "+1-555-0100",
    "department": "IT Support",
    "created_at": "2025-10-27T08:00:00.000Z",
    "updated_at": "2025-10-27T08:00:00.000Z"
  }
}
```

### PUT `/api/auth/profile`
Update the current user's profile information.

**Headers:**
```
Authorization: Bearer <token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "full_name": "John Doe",
  "email": "john.doe@example.com",
  "phone": "+1-555-1234",
  "department": "Engineering"
}
```

**Note:** All fields are optional. Only include the fields you want to update.

**Response:**
```json
{
  "success": true,
  "message": "Profile updated successfully",
  "profile": {
    "id": 1,
    "username": "admin",
    "email": "john.doe@example.com",
    "full_name": "John Doe",
    "role": "admin",
    "phone": "+1-555-1234",
    "department": "Engineering",
    "created_at": "2025-10-27T08:00:00.000Z",
    "updated_at": "2025-10-27T10:30:00.000Z"
  }
}
```

## Fields Available for Update

### For Tenant Users (Customers, Experts, Admin):
- `full_name` - Full name
- `email` - Email address
- `phone` - Phone number
- `department` - Department/team

### For Master Users:
- `full_name` - Full name
- `email` - Email address

## Error Responses

### 401 Unauthorized
```json
{
  "success": false,
  "message": "Token required"
}
```
or
```json
{
  "success": false,
  "message": "Invalid or expired token"
}
```

### 404 Not Found
```json
{
  "success": false,
  "message": "User not found"
}
```

### 400 Bad Request
```json
{
  "success": false,
  "message": "No fields to update"
}
```

## Usage Examples

### Get Profile
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/auth/profile
```

### Update Profile (Email Only)
```bash
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "newemail@example.com"}' \
  http://localhost:3000/api/auth/profile
```

### Update Multiple Fields
```bash
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "full_name": "John Doe",
    "email": "john.doe@example.com",
    "phone": "+1-555-1234",
    "department": "Engineering"
  }' \
  http://localhost:3000/api/auth/profile
```

## Frontend Integration

### JavaScript Example

```javascript
// Get profile
async function getProfile() {
  const token = localStorage.getItem('token');
  
  const response = await fetch('http://localhost:3000/api/auth/profile', {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  
  const data = await response.json();
  
  if (data.success) {
    console.log('Profile:', data.profile);
    // Display profile information in the UI
  }
}

// Update profile
async function updateProfile(profileData) {
  const token = localStorage.getItem('token');
  
  const response = await fetch('http://localhost:3000/api/auth/profile', {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(profileData)
  });
  
  const data = await response.json();
  
  if (data.success) {
    console.log('Profile updated:', data.profile);
    // Update UI with new profile data
  }
}

// Example: Update email only
updateProfile({ email: 'newemail@example.com' });

// Example: Update full profile
updateProfile({
  full_name: 'John Doe',
  email: 'john.doe@example.com',
  phone: '+1-555-1234',
  department: 'Engineering'
});
```

## Security

- ✅ All endpoints require authentication token
- ✅ Users can only update their own profile
- ✅ Token is validated on every request
- ✅ No sensitive fields (password) exposed in profile
- ✅ Email validation should be done on frontend

## Next Steps

1. **Add frontend UI** for My Profile page
2. **Add email validation** on frontend
3. **Add phone number validation** 
4. **Add profile picture upload** (optional)
5. **Add password change** directly from profile page

