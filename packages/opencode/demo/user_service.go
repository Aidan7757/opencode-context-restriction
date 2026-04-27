
package main

import (
	"errors"
	"fmt"
	"log"
	"strings"
	"time"
)


const maxRetries = 3
const sessionTimeout = 30 * time.Minute

var ErrNotFound = errors.New("user not found")
var ErrUnauthorized = errors.New("unauthorized")

type Role int

const (
	RoleGuest Role = iota
	RoleUser
	RoleAdmin
)

func (r Role) String() string {
	switch r {
	case RoleGuest:
		return "guest"
	case RoleUser:
		return "user"
	case RoleAdmin:
		return "admin"
	default:
		return "unknown"
	}
}



// <User>
// description: Core user struct — primary data model for this service
type User struct {
	ID        int
	Username  string
	Email     string
	Role      Role
	CreatedAt time.Time
	Active    bool
}

func (u User) IsAdmin() bool {
	return u.Role == RoleAdmin
}

func (u User) String() string {
	return fmt.Sprintf("User{id=%d, username=%q, role=%s}", u.ID, u.Username, u.Role)
}

// </User>

// <AuthenticateUser>
// description: Validates credentials and returns a session token; implements retry logic
func AuthenticateUser(username, password string) (string, error) {
	if username == "" || password == "" {
		return "", ErrUnauthorized
	}

	// Normalize username (trim whitespace, lowercase)
	username = strings.TrimSpace(strings.ToLower(username))

	user, err := lookupUser(username)
	if err != nil {
		return "", err
	}

	if !user.Active {
		return "", fmt.Errorf("account disabled: %w", ErrUnauthorized)
	}

	if !checkPassword(user, password) {
		return "", ErrUnauthorized
	}

	token, err := generateToken(user)
	if err != nil {
		return "", fmt.Errorf("token generation failed: %w", err)
	}

	log.Printf("authenticated user %s (role=%s)", user.Username, user.Role)
	return token, nil
}

// </AuthenticateUser>

// Updates a user's email with validation; admin-only for other users
func UpdateUserEmail(requester *User, targetUserID int, newEmail string) error {
	if requester == nil {
		return ErrUnauthorized
	}

	// Only admins can update other users' emails
	if requester.ID != targetUserID && !requester.IsAdmin() {
		return fmt.Errorf("cannot update another user's email: %w", ErrUnauthorized)
	}

	if !isValidEmail(newEmail) {
		return fmt.Errorf("invalid email address: %q", newEmail)
	}

	if err := persistEmailUpdate(targetUserID, newEmail); err != nil {
		return fmt.Errorf("failed to save email update: %w", err)
	}

	log.Printf("user %d email updated by %s", targetUserID, requester.Username)
	return nil
}

// <DeactivateUser>
// description: Soft-deletes a user account; requires admin privileges
func DeactivateUser(requester *User, targetUserID int) error {
	if requester == nil || !requester.IsAdmin() {
		return fmt.Errorf("deactivation requires admin: %w", ErrUnauthorized)
	}

	if requester.ID == targetUserID {
		return errors.New("admin cannot deactivate their own account")
	}

	if err := setActiveStatus(targetUserID, false); err != nil {
		return fmt.Errorf("deactivation failed: %w", err)
	}

	log.Printf("user %d deactivated by admin %s", targetUserID, requester.Username)
	return nil
}

// </DeactivateUser>


func lookupUser(username string) (*User, error) {
	// Stub — would hit a real database in production
	_ = username
	return nil, ErrNotFound
}

func checkPassword(user *User, password string) bool {
	// Stub — would use bcrypt or argon2 in production
	_ = user
	_ = password
	return false
}

func generateToken(user *User) (string, error) {
	// Stub — would sign a JWT in production
	return fmt.Sprintf("tok-%d-%d", user.ID, time.Now().Unix()), nil
}

func isValidEmail(email string) bool {
	return strings.Contains(email, "@") && strings.Contains(email, ".")
}

func persistEmailUpdate(userID int, email string) error {
	_ = userID
	_ = email
	return nil
}

func setActiveStatus(userID int, active bool) error {
	_ = userID
	_ = active
	return nil
}

func main() {
	fmt.Println("user_service demo — not intended to be run directly")
}
